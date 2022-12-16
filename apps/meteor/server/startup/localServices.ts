import { api, LocalBroker } from '@rocket.chat/core-sdk';

import { StreamerCentral } from '../modules/streamer/streamer.module';

const broker = new LocalBroker();

broker.onBroadcast((eventName: string, args: unknown[]) => {
	StreamerCentral.emit('broadcast', 'local', 'broadcast', [{ eventName, args }]);
});

api.setBroker(broker);
api.start();
