export interface Power {
	AC: string;
	Batt: string;
}

export interface AlarmData {
	timestamp: number;
	cmdRecv: number;
	type: string;
	areas: string[]; // E.g., ["disarm"]
	areasDetail: string[]; // E.g., ["Main Area"]
	areasStamp: number[];
	zones: string[];
	zonesStamp: number[];
	pgm: string[];
	pgmOb: string[];
	ukeys: any[];
	power: Power;
}

export interface AlarmPayload {
	status: string;
	type: string; // "alarmPayload"
	data: AlarmData;
	dataProlinks: any;
	gsmStamp: number;
	wifiStamp: number;
}

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
	Triggered = 'activated',
}

export enum OlarmAreaAction {
	Arm = 'area-arm',
	Stay = 'area-stay',
	Disarm = 'area-disarm',
}