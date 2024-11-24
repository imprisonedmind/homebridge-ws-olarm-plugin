import {Logger} from 'homebridge';
import {AlarmPayload, OlarmArea, OlarmAreaAction, OlarmAreaState} from './types'; // Import types from a shared file
import {Auth, Device} from './auth';

interface olarmProps {
	auth: Auth;
	log: Logger;
}

export class Olarm {
	private log: Logger;
	private auth: Auth;
	private areas: OlarmArea[] = []; // Internal state to hold areas
	private devicesMap: Map<string, Device> = new Map();

	constructor({auth, log}: olarmProps) {
		this.auth = auth;
		this.log = log;

		// Initialize devices map
		const devices = this.auth.getDevices();
		devices.forEach((device) => {
			this.devicesMap.set(device.id, device);
		});
	}

	// Method to process MQTT messages
	public processMqttMessage(deviceId: string, topic: string, message: string) {
		try {
			const payload: AlarmPayload = JSON.parse(message);
			if (payload.type === 'alarmPayload') {
				this.log.debug('Processing MQTT alarm payload');
				this.parseAreasFromPayload(deviceId, payload);
			} else {
				this.log.debug('Received non-alarm MQTT message');
			}
		} catch (error) {
			this.log.error('Failed to parse MQTT message:', error);
		}
	}

	// Parse the areas from the MQTT payload
	private parseAreasFromPayload(deviceId: string, payload: AlarmPayload) {
		const newAreas: OlarmArea[] = [];
		const areasStates = payload.data.areas; // E.g., ["disarm"]
		const areasDetails = payload.data.areasDetail;

		for (let i = 0; i < areasStates.length; i++) {
			const areaName = areasDetails[i] || `Area ${i + 1}`;
			const areaState = areasStates[i]; // E.g., "disarm"

			newAreas.push({
				areaName: areaName,
				deviceId: deviceId, // Include deviceId here
				areaNumber: i + 1,
				areaState: this.convertAreaState(areaState),
			});
		}

		this.areas = newAreas; // Update the internal areas state
		this.log.debug('Updated areas:', this.areas);
	}

	// Convert area state from string to OlarmAreaState enum
	private convertAreaState(state: string): OlarmAreaState {
		switch (state) {
			case 'arm':
				return OlarmAreaState.Armed;
			case 'disarm':
				return OlarmAreaState.Disarmed;
			case 'stay':
				return OlarmAreaState.ArmedStay;
			case 'notready':
				return OlarmAreaState.NotReady;
			case 'activated':
				return OlarmAreaState.Triggered;
			default:
				this.log.warn(`Unknown area state received: ${state}`);
				return OlarmAreaState.NotReady;
		}
	}

	// Method to get areas (called by discoverDevices)
	public getAreas(): OlarmArea[] {
		return this.areas;
	}

	// Optionally, you can have methods to handle area actions as before
	public async setArea(area: OlarmArea, action: OlarmAreaAction) {
		// Implement action handling, possibly via MQTT or API calls
	}
}