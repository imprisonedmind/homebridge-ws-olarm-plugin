import { CharacteristicValue, PlatformAccessory, Service } from "homebridge";

import { OlarmHomebridgePlatform } from "./platform";
import { OlarmArea, OlarmAreaAction, OlarmAreaState } from "./types";

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class OlarmAreaPlatformAccessory {
	private service: Service;
	// Keep track of the states within the accessory handler
	private currentState: OlarmAreaState;
	private targetState: OlarmAreaState;

	constructor(
		private readonly platform: OlarmHomebridgePlatform,
		private readonly accessory: PlatformAccessory<Record<string, any>> // Use generic context type
	) {

		// Initialize states from context or default
		this.currentState =
			this.accessory.context.area?.areaState || // Use optional chaining and fallback
			OlarmAreaState.Disarmed;
		this.targetState = this.currentState; // Start target state same as current

		this.platform.log.debug(`Initializing accessory: ${this.accessory.displayName}, initial state: ${this.currentState}`);


		// set accessory information
		this.accessory
			.getService(this.platform.Service.AccessoryInformation)!
			.setCharacteristic(
				this.platform.Characteristic.Manufacturer,
				"Olarm"
			)
			// Add model and serial number for better identification
			.setCharacteristic(
				this.platform.Characteristic.Model,
				"Olarm Area"
			)
			.setCharacteristic(
				this.platform.Characteristic.SerialNumber,
				`${this.accessory.context.area?.deviceId}-${this.accessory.context.area?.areaNumber}` || 'Unknown'
			);


		// get the SecuritySystem service if it exists, otherwise create a new SecuritySystem service
		this.service =
			this.accessory.getService(
				this.platform.Service.SecuritySystem
			) ||
			this.accessory.addService(
				this.platform.Service.SecuritySystem,
				this.accessory.displayName // Use display name for the service name
			);

		// set the service name (might be redundant if set in addService)
		this.service.setCharacteristic(
			this.platform.Characteristic.Name,
			this.accessory.displayName // Use accessory display name consistently
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

		// Update characteristics with initial values AFTER setting up handlers
		this.updateCharacteristics(this.currentState, this.targetState);

		this.platform.log.debug(`Accessory ${this.accessory.displayName} initialized.`);

	}

	// --- Helper function to update HomeKit characteristics ---
	private updateCharacteristics(current: OlarmAreaState, target: OlarmAreaState) {
		const hkCurrent = this.convertFromOlarmAreaStateToCurrentState(current);
		const hkTarget = this.convertFromOlarmAreaStateToTargetState(target);

		this.platform.log.debug(`[${this.accessory.displayName}] Updating HK chars: Current=${current}(${hkCurrent}), Target=${target}(${hkTarget})`);

		// Avoid unnecessary updates if values haven't changed
		if (this.service.getCharacteristic(this.platform.Characteristic.SecuritySystemCurrentState).value !== hkCurrent) {
			this.service.updateCharacteristic(
				this.platform.Characteristic.SecuritySystemCurrentState,
				hkCurrent
			);
		}
		if (this.service.getCharacteristic(this.platform.Characteristic.SecuritySystemTargetState).value !== hkTarget) {
			this.service.updateCharacteristic(
				this.platform.Characteristic.SecuritySystemTargetState,
				hkTarget
			);
		}
	}


	// --- Method called by the platform when MQTT state changes ---
	public updateStateFromExternal(newState: OlarmAreaState) {
		this.platform.log.info(`[${this.accessory.displayName}] External state update received: ${newState}`);

		// Update internal state tracking
		// If the new state is "NotReady", we keep the previous target state,
		// otherwise, the target state should align with the current state.
		this.currentState = newState;
		if (this.currentState !== OlarmAreaState.NotReady) {
			this.targetState = this.currentState;
		} else {
			// If it becomes NotReady, we reflect this in current state but don't change the target
			// User might still want it armed, but panel isn't ready
			this.platform.log.debug(`[${this.accessory.displayName}] State is NotReady, keeping target state as ${this.targetState}`);
		}

		// Update HomeKit characteristics to reflect the change
		this.updateCharacteristics(this.currentState, this.targetState);
	}

	// Conversion function for SecuritySystemCurrentState
	convertFromOlarmAreaStateToCurrentState = (
		s: OlarmAreaState
	): CharacteristicValue => {
		/**
		 * APPLE        OLARM
		 * STAY_ARM     Stay (ArmedStay)
		 * AWAY_ARM     Armed
		 * NIGHT_ARM    Sleep (ArmedSleep)
		 * DISARMED     Disarmed, NotReady
		 * ALARM_TRIGGERED Triggered (Activated)
		 */
		switch (s) {
			case OlarmAreaState.Armed:
				return this.platform.Characteristic.SecuritySystemCurrentState.AWAY_ARM;
			case OlarmAreaState.ArmedStay:
				return this.platform.Characteristic.SecuritySystemCurrentState.STAY_ARM;
			case OlarmAreaState.ArmedSleep:
				return this.platform.Characteristic.SecuritySystemCurrentState.NIGHT_ARM;
			case OlarmAreaState.Disarmed:
			case OlarmAreaState.NotReady: // Treat NotReady as Disarmed for current state
				return this.platform.Characteristic.SecuritySystemCurrentState.DISARMED;
			case OlarmAreaState.Triggered:
				return this.platform.Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED;
			default:
				this.platform.log.warn(`[${this.accessory.displayName}] Unknown Olarm state for CurrentState conversion: ${s}`);
				return this.platform.Characteristic.SecuritySystemCurrentState.DISARMED; // Default to DISARMED
		}
	};

	// Conversion function for SecuritySystemTargetState
	convertFromOlarmAreaStateToTargetState = (
		s: OlarmAreaState
	): CharacteristicValue => {
		// Target state cannot be 'Triggered' or 'NotReady'
		switch (s) {
			case OlarmAreaState.Armed:
				return this.platform.Characteristic.SecuritySystemTargetState.AWAY_ARM;
			case OlarmAreaState.ArmedStay:
				return this.platform.Characteristic.SecuritySystemTargetState.STAY_ARM;
			case OlarmAreaState.ArmedSleep:
				return this.platform.Characteristic.SecuritySystemTargetState.NIGHT_ARM;
			case OlarmAreaState.Disarmed:
			case OlarmAreaState.NotReady: // If panel reports not ready, desired state is likely DISARM
			case OlarmAreaState.Triggered: // If triggered, desired state is likely DISARM (to silence)
				return this.platform.Characteristic.SecuritySystemTargetState.DISARM;
			default:
				this.platform.log.warn(`[${this.accessory.displayName}] Unknown Olarm state for TargetState conversion: ${s}`);
				return this.platform.Characteristic.SecuritySystemTargetState.DISARM; // Default to DISARM
		}
	};

	// Convert HomeKit Target State Characteristic Value to OlarmAreaAction
	convertToOlarmAreaAction = (
		value: CharacteristicValue
	): OlarmAreaAction | null => {
		switch (value) {
			case this.platform.Characteristic.SecuritySystemTargetState.STAY_ARM:
				return OlarmAreaAction.Stay;
			case this.platform.Characteristic.SecuritySystemTargetState.AWAY_ARM:
				return OlarmAreaAction.Arm;
			case this.platform.Characteristic.SecuritySystemTargetState.NIGHT_ARM:
				return OlarmAreaAction.Sleep;
			case this.platform.Characteristic.SecuritySystemTargetState.DISARM:
				return OlarmAreaAction.Disarm;
			default:
				this.platform.log.warn(`[${this.accessory.displayName}] Cannot convert unknown HK TargetState value to Olarm action: ${value}`);
				return null; // Indicate no action
		}
	};

	/**
	 * Handle requests to get the current value of the "Security System Current State" characteristic
	 */
	async handleSecuritySystemCurrentStateGet(): Promise<CharacteristicValue> {
		// This should return the *last known state* stored in the handler.
		// The actual state is updated asynchronously by `updateStateFromExternal`.
		const currentStateValue = this.convertFromOlarmAreaStateToCurrentState(this.currentState);
		this.platform.log.info(`[${this.accessory.displayName}] GET CurrentState: returning ${this.currentState} (HK Value: ${currentStateValue})`);
		return currentStateValue;
	}

	/**
	 * Handle requests to get the current value of the "Security System Target State" characteristic
	 */
	async handleSecuritySystemTargetStateGet(): Promise<CharacteristicValue> {
		// Return the last *set* or *inferred* target state.
		const targetStateValue = this.convertFromOlarmAreaStateToTargetState(this.targetState);
		this.platform.log.info(`[${this.accessory.displayName}] GET TargetState: returning ${this.targetState} (HK Value: ${targetStateValue})`);
		return targetStateValue;
	}

	/**
	 * Handle requests to set the "Security System Target State" characteristic
	 */
	async handleSecuritySystemTargetStateSet(value: CharacteristicValue) {
		const hkTargetState = value as number; // Cast for clarity
		const requestedAction = this.convertToOlarmAreaAction(hkTargetState);

		if (requestedAction === null) {
			this.platform.log.warn(`[${this.accessory.displayName}] SET TargetState: Received invalid value ${hkTargetState}, ignoring.`);
			// Optionally throw an error back to HomeKit
			// throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
			return;
		}

		// Convert action back to OlarmAreaState to update internal target state
		// Note: This assumes action directly maps to a steady state.
		let newTargetState: OlarmAreaState;
		switch(requestedAction) {
			case OlarmAreaAction.Arm: newTargetState = OlarmAreaState.Armed; break;
			case OlarmAreaAction.Stay: newTargetState = OlarmAreaState.ArmedStay; break;
			case OlarmAreaAction.Sleep: newTargetState = OlarmAreaState.ArmedSleep; break;
			case OlarmAreaAction.Disarm: newTargetState = OlarmAreaState.Disarmed; break;
		}

		// Only send command if the target state is actually changing
		if (newTargetState === this.targetState && newTargetState === this.currentState) {
			this.platform.log.info(`[${this.accessory.displayName}] SET TargetState: Requested state ${newTargetState} matches current and target state. No action needed.`);
			// Update characteristic just in case HK UI is out of sync
			this.service.updateCharacteristic(this.platform.Characteristic.SecuritySystemTargetState, hkTargetState);
			return;
		}

		this.platform.log.info(
			`[${this.accessory.displayName}] SET TargetState: Received request ${newTargetState} (HK Value: ${hkTargetState}, Action: ${requestedAction}). Current: ${this.currentState}, Target: ${this.targetState}`
		);

		// Optimistically update the target state right away
		this.targetState = newTargetState;
		this.service.updateCharacteristic(this.platform.Characteristic.SecuritySystemTargetState, hkTargetState);


		// Send command to Olarm via the platform
		const area = this.accessory.context.area as OlarmArea;
		if (!area) {
			this.platform.log.error(`[${this.accessory.displayName}] Cannot set target state: Accessory context is missing area information.`);
			// Optionally revert target state? Or throw?
			throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
			// return;
		}

		try {
			const success = await this.platform.olarm!.setArea(area, requestedAction);
			if (success) {
				this.platform.log.info(`[${this.accessory.displayName}] Successfully sent command "${requestedAction}" to Olarm. Waiting for MQTT confirmation...`);
				// Do NOT update currentState here. Wait for the MQTT message confirmation
				// which will call updateStateFromExternal. HomeKit will show the target state
				// until the current state updates.
			} else {
				this.platform.log.error(`[${this.accessory.displayName}] Failed to send command "${requestedAction}" to Olarm.`);
				// Revert the target state in HomeKit since the command failed?
				// Or leave it, assuming it might eventually succeed or user will retry?
				// Let's revert for now to avoid confusion.
				this.targetState = this.currentState; // Revert internal target state
				this.service.updateCharacteristic(
					this.platform.Characteristic.SecuritySystemTargetState,
					this.convertFromOlarmAreaStateToTargetState(this.currentState)
				);
				throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
			}
		} catch (error) {
			this.platform.log.error(`[${this.accessory.displayName}] Error sending command "${requestedAction}":`, error);
			// Revert target state on error
			this.targetState = this.currentState; // Revert internal target state
			this.service.updateCharacteristic(
				this.platform.Characteristic.SecuritySystemTargetState,
				this.convertFromOlarmAreaStateToTargetState(this.currentState)
			);
			throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
		}
	}

	// Optional: Add a cleanup method if needed
	// public destroy() {
	//   this.platform.log.info(`Destroying handler for accessory: ${this.accessory.displayName}`);
	//   // Unregister listeners? Unlikely needed with Homebridge's model.
	// }
}