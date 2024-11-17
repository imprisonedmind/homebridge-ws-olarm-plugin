import {CharacteristicValue, PlatformAccessory, Service} from "homebridge";

import {OlarmHomebridgePlatform} from "./platform";
import {Olarm, OlarmArea, OlarmAreaAction, OlarmAreaState} from "./olarm";

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class OlarmAreaPlatformAccessory {
	private service: Service;
	private currentState: OlarmAreaState = OlarmAreaState.Disarmed;
	private targetState: OlarmAreaState = OlarmAreaState.Disarmed;

	constructor(
		private readonly platform: OlarmHomebridgePlatform,
		private readonly accessory: PlatformAccessory,
	) {
		// set accessory information
		this.accessory
			.getService(this.platform.Service.AccessoryInformation)!
			.setCharacteristic(this.platform.Characteristic.Manufacturer, "Olarm");

		// get the SecuritySystem service if it exists, otherwise create a new SecuritySystem service
		// you can create multiple services for each accessory

		this.service =
			this.accessory.getService(this.platform.Service.SecuritySystem) ||
			this.accessory.addService(this.platform.Service.SecuritySystem);

		// set the service name, this is what is displayed as the default name on the Home app
		// in this example we are using the name we stored in the `accessory.context` in the `discoverDevices` method.
		this.service.setCharacteristic(
			this.platform.Characteristic.Name,
			this.accessory.context.area.areaName,
		);

		// each service must implement at-minimum the "required characteristics" for the given service type
		// see https://developers.homebridge.io/#/service/SecuritySystem

		// register handlers for the SecuritySystemCurrentState Characteristic
		this.service
			.getCharacteristic(
				this.platform.Characteristic.SecuritySystemCurrentState,
			)
			.onGet(this.handleSecuritySystemCurrentStateGet.bind(this));

		// register handlers for the SecuritySystemTargetState Characteristic
		this.service
			.getCharacteristic(this.platform.Characteristic.SecuritySystemTargetState)
			.onGet(this.handleSecuritySystemTargetStateGet.bind(this))
			.onSet(this.handleSecuritySystemTargetStateSet.bind(this));

		// Initialize the states
		this.currentState = this.accessory.context.area.areaState;
		this.targetState = this.currentState;

		// /**
		//  * Updating characteristics values asynchronously.
		//  *
		//  * Example showing how to update the state of a Characteristic asynchronously instead
		//  * of using the `on('get')` handlers.
		//  * Here we change update the motion sensor trigger states on and off every 10 seconds
		//  * the `updateCharacteristic` method.
		//  *
		//  */
		// let motionDetected = false;
		// setInterval(() => {
		//   // EXAMPLE - inverse the trigger
		//   motionDetected = !motionDetected;

		//   // push the new value to HomeKit
		//   motionSensorOneService.updateCharacteristic(this.platform.Characteristic.MotionDetected, motionDetected);
		//   motionSensorTwoService.updateCharacteristic(this.platform.Characteristic.MotionDetected, !motionDetected);

		//   this.platform.log.debug('Triggering motionSensorOneService:', motionDetected);
		//   this.platform.log.debug('Triggering motionSensorTwoService:', !motionDetected);
		// }, 10000);
	}

	convertFromOlarmAreaState = (s: OlarmAreaState): CharacteristicValue => {
		/**
		 * APPLE  OLARM
		 * Home   <unused> -> Stay
		 * Away   Armed
		 * Night  Stay
		 * Off    Disarmed
		 * ...
		 */
		switch (s) {
			case OlarmAreaState.Armed:
				return this.platform.Characteristic.SecuritySystemCurrentState.AWAY_ARM; // Away => Armed
			case OlarmAreaState.ArmedStay:
				return this.platform.Characteristic.SecuritySystemCurrentState
					.NIGHT_ARM; // Night => Stay
			case OlarmAreaState.Disarmed:
				return this.platform.Characteristic.SecuritySystemCurrentState.DISARMED;
			case OlarmAreaState.NotReady:
				return this.platform.Characteristic.SecuritySystemCurrentState.DISARMED;
			case OlarmAreaState.Triggered: // todo
			default:
				return this.platform.Characteristic.SecuritySystemCurrentState.DISARMED;
		}
		// static readonly STAY_ARM = 0; // "Home"
		// static readonly AWAY_ARM = 1; // "Away"
		// static readonly NIGHT_ARM = 2; // "Night"
		// static readonly DISARMED = 3; // "Off"
		// static readonly ALARM_TRIGGERED = 4; // ?
	};

	convertToOlarmAreaState = (s: CharacteristicValue): OlarmAreaState => {
		switch (s) {
			case this.platform.Characteristic.SecuritySystemCurrentState.STAY_ARM:
				return OlarmAreaState.ArmedStay;
			case this.platform.Characteristic.SecuritySystemCurrentState.AWAY_ARM:
				return OlarmAreaState.Armed;
			case this.platform.Characteristic.SecuritySystemCurrentState.NIGHT_ARM:
				return OlarmAreaState.ArmedStay;
			case this.platform.Characteristic.SecuritySystemCurrentState.DISARMED:
				return OlarmAreaState.Disarmed;
			case this.platform.Characteristic.SecuritySystemCurrentState
				.ALARM_TRIGGERED:
				return OlarmAreaState.Triggered; // todo
			default:
				return OlarmAreaState.Disarmed;
		}
	};

	/**
	 * Handle requests to get the current value of the "Security System Current State" characteristic
	 */
	async handleSecuritySystemCurrentStateGet() {
		const olarmAreas = await this.platform.olarm.getAreas();
		const area = this.accessory.context.area as OlarmArea;
		const olarmArea = olarmAreas.find((oa) => oa.areaName === area.areaName);

		this.platform.log.info(
			`GET CurrentState (${olarmArea?.areaName}) from ${this.currentState} to ${olarmArea!.areaState} (target: ${this.targetState})`,
		);
		this.currentState = olarmArea!.areaState;

		if (this.currentState !== OlarmAreaState.NotReady)
			this.targetState = this.currentState;

		// Update HomeKit state
		this.service.updateCharacteristic(
			this.platform.Characteristic.SecuritySystemCurrentState,
			this.convertFromOlarmAreaState(this.currentState),
		);
		this.service.updateCharacteristic(
			this.platform.Characteristic.SecuritySystemTargetState,
			this.convertFromOlarmAreaState(this.targetState),
		);

		return this.convertFromOlarmAreaState(olarmArea!.areaState);
	}

	/**
	 * Handle requests to get the current value of the "Security System Target State" characteristic
	 */
	async handleSecuritySystemTargetStateGet() {
		this.platform.log.info(
			`GET TargetState (${this.accessory.context.area.areaName}) ${this.targetState} (current: ${this.currentState})`,
		);
		return this.convertFromOlarmAreaState(this.targetState);
	}

	/**
	 * Handle requests to set the "Security System Target State" characteristic
	 */
	async handleSecuritySystemTargetStateSet(value: CharacteristicValue) {
		const olarmAreaStateValue = this.convertToOlarmAreaState(value);

		// Determine olarm action
		const area = this.accessory.context.area;
		let olarmAreaAction = OlarmAreaAction.Disarm;
		if (olarmAreaStateValue === OlarmAreaState.Armed)
			olarmAreaAction = OlarmAreaAction.Arm;
		if (olarmAreaStateValue === OlarmAreaState.ArmedStay)
			olarmAreaAction = OlarmAreaAction.Stay;

		this.platform.log.info(
			`SET TargetState (${this.accessory.context.area.areaName}) from ${this.targetState} to ${olarmAreaStateValue} with "${olarmAreaAction}"`,
		);
		this.targetState = olarmAreaStateValue;

		// Ping olarm to update
		await this.platform.olarm.setArea(area, olarmAreaAction);

		// Update actual state
		this.currentState = this.targetState;
		this.platform.log.info(
			" - (SET) Updated",
			this.accessory.context.area.areaName,
			"to",
			olarmAreaStateValue,
		);

		// Update HomeKit state
		this.service.updateCharacteristic(
			this.platform.Characteristic.SecuritySystemCurrentState,
			this.convertFromOlarmAreaState(this.currentState),
		);
		this.service.updateCharacteristic(
			this.platform.Characteristic.SecuritySystemTargetState,
			this.convertFromOlarmAreaState(this.targetState),
		);
	}
}
