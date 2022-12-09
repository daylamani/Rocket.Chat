import { Meteor } from 'meteor/meteor';
import moment from 'moment';
import {
	Rooms as RoomRaw,
	LivechatRooms as LivechatRoomsRaw,
	LivechatDepartment as LivechatDepartmentRaw,
	LivechatCustomField,
	LivechatInquiry,
} from '@rocket.chat/models';

import { memoizeDebounce } from './debounceByParams';
import { Users, Messages } from '../../../../../app/models/server';
import { settings } from '../../../../../app/settings/server';
import { RoutingManager } from '../../../../../app/livechat/server/lib/RoutingManager';
import { dispatchAgentDelegated } from '../../../../../app/livechat/server/lib/Helper';
import { logger, helperLogger } from './logger';
import { OmnichannelQueueInactivityMonitor } from './QueueInactivityMonitor';
import { api } from '../../../../../server/sdk/api';
import { getInquirySortMechanismSetting } from '../../../../../app/livechat/server/lib/settings';

export const getMaxNumberSimultaneousChat = async ({ agentId, departmentId }) => {
	if (departmentId) {
		const department = await LivechatDepartmentRaw.findOneById(departmentId);
		const { maxNumberSimultaneousChat } = department || {};
		if (maxNumberSimultaneousChat > 0) {
			return maxNumberSimultaneousChat;
		}
	}

	if (agentId) {
		const user = Users.getAgentInfo(agentId);
		const { livechat: { maxNumberSimultaneousChat } = {} } = user || {};
		if (maxNumberSimultaneousChat > 0) {
			return maxNumberSimultaneousChat;
		}
	}

	return settings.get('Livechat_maximum_chats_per_agent');
};

const getWaitingQueueMessage = async (departmentId) => {
	const department = departmentId && (await LivechatDepartmentRaw.findOneById(departmentId));
	if (department && department.waitingQueueMessage) {
		return department.waitingQueueMessage;
	}

	return settings.get('Livechat_waiting_queue_message');
};

const getQueueInfo = async (department) => {
	const numberMostRecentChats = settings.get('Livechat_number_most_recent_chats_estimate_wait_time');
	const statistics = await RoomRaw.getMostRecentAverageChatDurationTime(numberMostRecentChats, department);
	const text = await getWaitingQueueMessage(department);
	const message = {
		text,
		user: { _id: 'rocket.cat', username: 'rocket.cat' },
	};
	return { message, statistics, numberMostRecentChats };
};

const getSpotEstimatedWaitTime = (spot, maxNumberSimultaneousChat, avgChatDuration) => {
	if (!maxNumberSimultaneousChat || !avgChatDuration) {
		return;
	}
	// X = spot
	// N = maxNumberSimultaneousChat
	// Estimated Wait Time = ([(N-1)/X]+1) *Average Chat Time of Most Recent X(Default = 100) Chats
	return ((spot - 1) / maxNumberSimultaneousChat + 1) * avgChatDuration;
};

export const normalizeQueueInfo = async ({ position, queueInfo, department }) => {
	if (!queueInfo) {
		queueInfo = await getQueueInfo(department);
	}

	const { message, numberMostRecentChats, statistics: { avgChatDuration } = {} } = queueInfo;
	const spot = position + 1;
	const estimatedWaitTimeSeconds = getSpotEstimatedWaitTime(spot, numberMostRecentChats, avgChatDuration);
	return { spot, message, estimatedWaitTimeSeconds };
};

export const dispatchInquiryPosition = async (inquiry, queueInfo) => {
	const { position, department } = inquiry;
	const data = await normalizeQueueInfo({ position, queueInfo, department });
	const propagateInquiryPosition = Meteor.bindEnvironment((inquiry) => {
		api.broadcast('omnichannel.room', inquiry.rid, {
			type: 'queueData',
			data,
		});
	});

	return setTimeout(() => {
		propagateInquiryPosition(inquiry);
	}, 1000);
};

export const dispatchWaitingQueueStatus = async (department) => {
	if (!settings.get('Livechat_waiting_queue') && !settings.get('Omnichannel_calculate_dispatch_service_queue_statistics')) {
		return;
	}

	helperLogger.debug(`Updating statuses for queue ${department || 'Public'}`);
	const queue = await LivechatInquiry.getCurrentSortedQueueAsync({
		department,
		queueSortBy: getInquirySortMechanismSetting(),
	});

	if (!queue.length) {
		return;
	}

	const queueInfo = await getQueueInfo(department);
	queue.forEach((inquiry) => {
		dispatchInquiryPosition(inquiry, queueInfo);
	});
};

// When dealing with lots of queued items we need to make sure to notify their position
// but we don't need to notify _each_ change that takes place, just their final position
export const debouncedDispatchWaitingQueueStatus = memoizeDebounce(dispatchWaitingQueueStatus, 1200);

export const processWaitingQueue = async (department, inquiry) => {
	const queue = department || 'Public';
	helperLogger.debug(`Processing items on queue ${queue}`);

	helperLogger.debug(`Processing inquiry ${inquiry._id} from queue ${queue}`);
	const { defaultAgent } = inquiry;
	const room = await RoutingManager.delegateInquiry(inquiry, defaultAgent);

	const propagateAgentDelegated = Meteor.bindEnvironment((rid, agentId) => {
		dispatchAgentDelegated(rid, agentId);
	});

	if (room && room.servedBy) {
		const {
			_id: rid,
			servedBy: { _id: agentId },
		} = room;
		helperLogger.debug(`Inquiry ${inquiry._id} taken successfully by agent ${agentId}. Notifying`);
		setTimeout(() => {
			propagateAgentDelegated(rid, agentId);
		}, 1000);

		return true;
	}

	return false;
};

export const setPredictedVisitorAbandonmentTime = async (room) => {
	if (
		!room.v ||
		!room.v.lastMessageTs ||
		!settings.get('Livechat_abandoned_rooms_action') ||
		settings.get('Livechat_abandoned_rooms_action') === 'none'
	) {
		return;
	}

	let secondsToAdd = settings.get('Livechat_visitor_inactivity_timeout');

	const department = room.departmentId && (await LivechatDepartmentRaw.findOneById(room.departmentId));
	if (department && department.visitorInactivityTimeoutInSeconds) {
		secondsToAdd = department.visitorInactivityTimeoutInSeconds;
	}

	if (secondsToAdd <= 0) {
		return;
	}

	const willBeAbandonedAt = moment(room.v.lastMessageTs).add(Number(secondsToAdd), 'seconds').toDate();
	await LivechatRoomsRaw.setPredictedVisitorAbandonmentByRoomId(room._id, willBeAbandonedAt);
};

export const updatePredictedVisitorAbandonment = async () => {
	if (!settings.get('Livechat_abandoned_rooms_action') || settings.get('Livechat_abandoned_rooms_action') === 'none') {
		await LivechatRoomsRaw.unsetAllPredictedVisitorAbandonment();
	} else {
		// Eng day: use a promise queue to update the predicted visitor abandonment time instead of all at once
		const promisesArray = [];
		await LivechatRoomsRaw.findOpen().forEach((room) => promisesArray.push(setPredictedVisitorAbandonmentTime(room)));

		await Promise.all(promisesArray);
	}
};

export const updateQueueInactivityTimeout = () => {
	const queueTimeout = settings.get('Livechat_max_queue_wait_time');
	if (queueTimeout <= 0) {
		logger.debug('QueueInactivityTimer: Disabling scheduled closing');
		OmnichannelQueueInactivityMonitor.stop();
		return;
	}

	logger.debug('QueueInactivityTimer: Updating estimated inactivity time for queued items');
	LivechatInquiry.getQueuedInquiries({ fields: { _updatedAt: 1 } }).forEach((inq) => {
		const aggregatedDate = moment(inq._updatedAt).add(queueTimeout, 'minutes');
		try {
			return OmnichannelQueueInactivityMonitor.scheduleInquiry(inq._id, new Date(aggregatedDate.format()));
		} catch (e) {
			// this will usually happen if other instance attempts to re-create a job
			logger.error({ err: e });
		}
	});
};

export const updateRoomSLAHistory = (rid, user, sla) => {
	const history = {
		slaData: {
			definedBy: user,
			sla: sla || {},
		},
	};

	Messages.createSLAHistoryWithRoomIdMessageAndUser(rid, '', user, history);
};

export const updateInquiryQueueSla = async (roomId, sla) => {
	const inquiry = await LivechatInquiry.findOneByRoomId(roomId, { projection: { rid: 1, ts: 1 } });
	if (!inquiry) {
		return;
	}

	let { ts: estimatedServiceTimeAt } = inquiry;
	let estimatedWaitingTimeQueue = 0;

	if (sla) {
		const { dueTimeInMinutes } = sla;
		estimatedWaitingTimeQueue = dueTimeInMinutes;
		estimatedServiceTimeAt = new Date(estimatedServiceTimeAt.setMinutes(estimatedServiceTimeAt.getMinutes() + dueTimeInMinutes));
	}

	await LivechatInquiry.setEstimatedServiceTimeAt(inquiry.rid, {
		estimatedWaitingTimeQueue,
		estimatedServiceTimeAt,
	});
};

export const removeSLAFromRooms = async (slaId) => {
	const promises = [];
	LivechatRoomsRaw.findOpenBySlaId(slaId).forEach((room) => {
		promises.push(updateInquiryQueueSla(room._id));
	});
	await Promise.all(promises.length ? promises : []);

	await LivechatRoomsRaw.unsetSlaById(slaId);
};

export const updateSLAInquiries = async (sla) => {
	if (!sla) {
		return;
	}

	const { _id: slaId } = sla;
	const promises = LivechatRoomsRaw.findOpenBySlaId(slaId).forEach((room) => {
		updateInquiryQueueSla(room._id, sla);
	});
	await Promise.allSettled(promises.length ? promises : []);
};

export const getLivechatCustomFields = async () => {
	const customFields = await LivechatCustomField.find({
		visibility: 'visible',
		scope: 'visitor',
		public: true,
	}).toArray();
	return customFields.map(({ _id, label, regexp, required = false, type, defaultValue = null, options }) => ({
		_id,
		label,
		regexp,
		required,
		type,
		defaultValue,
		...(options && options !== '' && { options: options.split(',') }),
	}));
};

export const getLivechatQueueInfo = async (room) => {
	if (!room) {
		return null;
	}

	if (!settings.get('Livechat_waiting_queue')) {
		return null;
	}

	if (!settings.get('Omnichannel_calculate_dispatch_service_queue_statistics')) {
		return null;
	}

	const { _id: rid, departmentId: department } = room;
	const inquiry = await LivechatInquiry.findOneByRoomId(rid, { projection: { _id: 1, status: 1 } });
	if (!inquiry) {
		return null;
	}

	const { _id, status } = inquiry;
	if (status !== 'queued') {
		return null;
	}

	const [inq] = await LivechatInquiry.getCurrentSortedQueueAsync({
		_id,
		department,
		queueSortBy: getInquirySortMechanismSetting(),
	});

	if (!inq) {
		return null;
	}

	return normalizeQueueInfo(inq);
};
