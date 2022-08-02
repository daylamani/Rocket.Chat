import { Box } from '@rocket.chat/fuselage';
import React, { ComponentProps, FC } from 'react';

const InfoPanelLabel: FC<ComponentProps<typeof Box>> = (props) => <Box mb='x8' fontScale='p2m' color='default' {...props} />;

export default InfoPanelLabel;
