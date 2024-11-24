import {CharacteristicValue, PlatformAccessory, Service} from "homebridge";

import {OlarmHomebridgePlatform} from "./platform";
import {OlarmArea, OlarmAreaAction, OlarmAreaState} from "./types";

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
		private readonly accessory: PlatformAccessory
	) {
		// set accessory information
		this.accessory
			.getService(this.platform.Service.AccessoryInformation)!
			.setCharacteristic(
				this.platform.Characteristic.Manufacturer,
				"Olarm"
			);

		// get the SecuritySystem service if it exists, otherwise create a new SecuritySystem service
		this.service =
			this.accessory.getService(
				this.platform.Service.SecuritySystem
			) ||
			this.accessory.addService(
				this.platform.Service.SecuritySystem
			);

		// set the service name
		this.service.setCharacteristic(
			this.platform.Characteristic.Name,
			this.accessory.context.area.areaName
		);

		// register handlers for the SecuritySystemCurrentState Characteristic
		this.service
			.getCharacteristic(
				this.platform.Characteristic.SecuritySystemCurrentState
			)
			.onGet(this.handleSecuritySystemCurrentStateGet.bind(this));

		// register handlers for the SecuritySystemTargetState Characteristic
		this.service
			.getCharacteristic(
				this.platform.Characteristic.SecuritySystemTargetState
			)
			.onGet(this.handleSecuritySystemTargetStateGet.bind(this))
			.onSet(this.handleSecuritySystemTargetStateSet.bind(this));

		// Initialize the states
		this.currentState =
			this.accessory.context.area.areaState ||
			OlarmAreaState.Disarmed;
		this.targetState = this.currentState;

		// Initialize the characteristics with default values
		this.service.updateCharacteristic(
			this.platform.Characteristic.SecuritySystemCurrentState,
			this.convertFromOlarmAreaStateToCurrentState(this.currentState)
		);

		this.service.updateCharacteristic(
			this.platform.Characteristic.SecuritySystemTargetState,
			this.convertFromOlarmAreaStateToTargetState(this.targetState)
		);
	}

	// Conversion function for SecuritySystemCurrentState
	convertFromOlarmAreaStateToCurrentState = (
		s: OlarmAreaState
	): CharacteristicValue => {
		/**
		 * APPLE  OLARM
		 * Home   Stay
		 * Away   Armed
		 * Night  Sleep
		 * Off    Disarmed
		 * ...    TODO: add support for triggered
		 */
		switch (s) {
			case OlarmAreaState.Armed:
				return this.platform.Characteristic.SecuritySystemCurrentState.AWAY_ARM;
			case OlarmAreaState.ArmedStay:
				return this.platform.Characteristic.SecuritySystemCurrentState.STAY_ARM;
			case OlarmAreaState.ArmedSleep:
				return this.platform.Characteristic.SecuritySystemCurrentState.NIGHT_ARM;
			case OlarmAreaState.Disarmed:
			case OlarmAreaState.NotReady:
				return this.platform.Characteristic.SecuritySystemCurrentState.DISARMED;
			case OlarmAreaState.Triggered:
				return this.platform.Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED;
			default:
				return this.platform.Characteristic.SecuritySystemCurrentState
					.DISARMED; // Default to DISARMED
		}
	};

	// Conversion function for SecuritySystemTargetState
	convertFromOlarmAreaStateToTargetState = (
		s: OlarmAreaState
	): CharacteristicValue => {

		switch (s) {
			case OlarmAreaState.Armed:
				return this.platform.Characteristic.SecuritySystemTargetState.AWAY_ARM;
			case OlarmAreaState.ArmedStay:
				return this.platform.Characteristic.SecuritySystemTargetState.STAY_ARM;
			case OlarmAreaState.ArmedSleep:
				return this.platform.Characteristic.SecuritySystemTargetState.NIGHT_ARM;
			case OlarmAreaState.Disarmed:
			case OlarmAreaState.NotReady:
				return this.platform.Characteristic.SecuritySystemTargetState.DISARM;
			default:
				return this.platform.Characteristic.SecuritySystemTargetState.DISARM; // Default to DISARM
		}
	};

	convertToOlarmAreaState = (
		s: CharacteristicValue
	): OlarmAreaState => {


		switch (s) {
			case this.platform.Characteristic.SecuritySystemTargetState.STAY_ARM:
				return OlarmAreaState.ArmedStay;
			case this.platform.Characteristic.SecuritySystemTargetState.AWAY_ARM:
				return OlarmAreaState.Armed;
			case this.platform.Characteristic.SecuritySystemTargetState.NIGHT_ARM:
				return OlarmAreaState.ArmedSleep;
			case this.platform.Characteristic.SecuritySystemTargetState.DISARM:
				return OlarmAreaState.Disarmed;
			default:
				return OlarmAreaState.Disarmed; // Default to Disarmed
		}
	};

	/**
	 * Handle requests to get the current value of the "Security System Current State" characteristic
	 */
	async handleSecuritySystemCurrentStateGet() {
		const olarmAreas = this.platform.olarm!.getAreas();
		const area = this.accessory.context.area as OlarmArea;
		const olarmArea = olarmAreas.find(
			(oa) => oa.areaName === area.areaName
		);

		if (!olarmArea) {
			this.platform.log.warn(
				`No area data available for ${area.areaName}, returning default state.`
			);
			return this.convertFromOlarmAreaStateToCurrentState(
				this.currentState
			);
		}

		this.platform.log.info(
			`GET CurrentState (${olarmArea.areaName}) from ${this.currentState} to ${olarmArea.areaState} (target: ${this.targetState})`
		);
		this.currentState = olarmArea.areaState;

		if (this.currentState !== OlarmAreaState.NotReady)
			this.targetState = this.currentState;

		// Update HomeKit state
		this.service.updateCharacteristic(
			this.platform.Characteristic.SecuritySystemCurrentState,
			this.convertFromOlarmAreaStateToCurrentState(this.currentState)
		);
		this.service.updateCharacteristic(
			this.platform.Characteristic.SecuritySystemTargetState,
			this.convertFromOlarmAreaStateToTargetState(this.targetState)
		);

		return this.convertFromOlarmAreaStateToCurrentState(
			this.currentState
		);
	}

	/**
	 * Handle requests to get the current value of the "Security System Target State" characteristic
	 */
	async handleSecuritySystemTargetStateGet() {
		this.platform.log.info(
			`GET TargetState (${this.accessory.context.area.areaName}) ${this.targetState} (current: ${this.currentState})`
		);
		return this.convertFromOlarmAreaStateToTargetState(this.targetState);
	}

	/**
	 * Handle requests to set the "Security System Target State" characteristic
	 */
	async handleSecuritySystemTargetStateSet(
		value: CharacteristicValue
	) {
		const olarmAreaStateValue = this.convertToOlarmAreaState(value);

		// Determine olarm action
		const area = this.accessory.context.area;

		let olarmAreaAction;

		switch (true) {
			case (olarmAreaStateValue === OlarmAreaState.Armed):
				olarmAreaAction = OlarmAreaAction.Arm
				break;
			case (olarmAreaStateValue === OlarmAreaState.ArmedStay):
				olarmAreaAction = OlarmAreaAction.Stay
				break;
			case (olarmAreaStateValue === OlarmAreaState.ArmedSleep):
				olarmAreaAction = OlarmAreaAction.Sleep
				break;
			default:
				olarmAreaAction = OlarmAreaAction.Disarm;
				break;
		}

		this.platform.log.info(
			`SET TargetState (${this.accessory.context.area.areaName}) from ${this.targetState} to ${olarmAreaStateValue} with "${olarmAreaAction}"`
		);
		this.targetState = olarmAreaStateValue;

		// Send command to Olarm
		await this.platform.olarm!.setArea(area, olarmAreaAction);

		// Update actual state
		this.currentState = this.targetState;
		this.platform.log.info(
			" - (SET) Updated",
			this.accessory.context.area.areaName,
			"to",
			olarmAreaStateValue
		);

		// Update HomeKit state
		this.service.updateCharacteristic(
			this.platform.Characteristic.SecuritySystemCurrentState,
			this.convertFromOlarmAreaStateToCurrentState(this.currentState)
		);
		this.service.updateCharacteristic(
			this.platform.Characteristic.SecuritySystemTargetState,
			this.convertFromOlarmAreaStateToTargetState(this.targetState)
		);
	}
}
