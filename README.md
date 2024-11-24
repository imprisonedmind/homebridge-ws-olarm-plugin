# homebridge-ws-olarm-plugin

This plugin creates a HomeKit interface for an [Olarm](https://olarm.co) alarm system.

## Guide

### Installing

1. On your Homebridge device, run `npm i -g homebridge-ws-olarm-plugin`
2. ~~Create an API key on Olarm ([here](https://user.olarm.co/#/api))~~ // no longer 
   required, prefer user/pass auth.
2. Set up the new platform in your Homebridge config.json
```
{
  "platform": "OlarmWSHomebridgePlugin",
  "name": "homebridge-ws-olarm-plugin",
  "userEmailPhone": "<your preffered login method>",
  "userPass": "<your password>"
  "tokens": "tokens.json"
}
```
3. Restart your Homebridge

### Usage

The plugin will automatically scan all devices on your Olarm account and pull in their areas. Each area will be created as a separate accessory.

Note that HomeKit forces 4 alarm states: `Home`, `Away`, `Night` and `Off` which as of writing can't be customised. Hence, the states have been mapped to the following:

- `Home` -> Armed Stay (and changes to `Night` automatically)
- `Away` -> Armed
- `Night` -> Armed Stay
- `Off` -> Disarmed.

Triggered / alarm activated states are not yet connected.

### Development

Follow the below instructions if you want to fork and evolve this plugin.

_Note: YMMV with setup guides below_

1. Clone the repo onto your device that hosts your Homebridge instance.
2. Run `npm install` to install dependencies.
3. Run `npm run watch` to have `nodemon` run and keep it updated. It also runs `npm link`.

**Now to plug it into your Homebridge**

1. Run `npm run build` to build the plugin into `/dist` (`npm run watch` will do the same)
2. Run `pwd` to get the full path to the plugin (e.g. `/home/pi/HomebridgePlugins/olarm-plugin`)
3. Inside Homebridge's directory, Run `npm link` if needed `sudo npm link <path from step 2>`
3. Update the Homebridge `config.json` with this platform:
```
{
  "platform": "OlarmWSHomebridgePlugin",
  "name": "homebridge-ws-olarm-plugin",
  "userEmailPhone": "<your preffered login method>",
  "tokens": "tokens.json"
}
```
4. Restart your Homebridge `sudo systemctl restart homebridge`


