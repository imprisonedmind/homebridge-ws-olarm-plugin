import {Logger} from 'homebridge';
import fetch from 'node-fetch';
import {Auth} from './auth';

export interface OlarmArea {
	areaName: string;
	deviceId: string;
	areaNumber: number;
	areaState: OlarmAreaState;
}

export enum OlarmAreaState {
	Armed = 'arm',
	Disarmed = 'disarm',
	ArmedStay = 'stay',
	NotReady = 'notready',
	Triggered = 'activated', // ALARM_TRIGGERED
}

export enum OlarmAreaAction {
	Arm = 'area-arm',
	Stay = 'area-stay',
	Disarm = 'area-disarm',
}

interface props {
	auth: Auth;
	log: Logger;
}

export class Olarm {
	private auth: Auth;
	private log: Logger;

	constructor({auth, log,}: props) {
		this.auth = auth;
		this.log = log;
	}

	// Get all the available areas we have
	getAreas = async (): Promise<OlarmArea[]> => {
		await this.auth.initialize(); // Ensure tokens are loaded and valid
		const tokens = this.auth.getTokens();
		if (!tokens.userIndex) {
			throw new Error('User index is not available');
		}
		this.log.debug('Fetching areas from Olarm API');
		const response = await fetch(
			`https://api-legacy.olarm.com/api/v2/users/${tokens.userIndex}`,
			{
				method: 'GET',
				headers: {Authorization: `Bearer ${tokens.accessToken}`},
			},
		);
		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(
				`Failed to fetch devices: ${response.status} ${response.statusText} - ${errorText}`,
			);
		}
		const payload = await response.json();
		const olarmAreas: OlarmArea[] = [];
		this.log.debug('---------------> WE GOT AREAS', payload);
		for (const device of payload.devices) {
			for (const [i, l] of device.profile.areasLabels.entries()) {
				olarmAreas.push({
					areaName: l,
					areaState: device.state.areas[i],
					areaNumber: i + 1,
					deviceId: device.id,
				});
			}
		}
		return olarmAreas;
	};

	setArea = async (area: OlarmArea, action: OlarmAreaAction) => {
		const tokens = this.auth.getTokens();
		const response = await fetch(
			`https://api.olarm.com/api/v4/devices/${area.deviceId}/actions`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${tokens.accessToken}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					actionCmd: action,
					actionNum: area.areaNumber,
				}),
			},
		);
		const result = await response.text();
		this.log.info('Response:', result);
	};
}