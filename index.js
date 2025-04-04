// Control module for Neutrik NA2-IO-DPRO
// Andrew Broughton <andy@checkcheckonetwo.com>
// October 2024 Version 1.0.3 (for Companion v3)

const { InstanceBase, InstanceStatus, Regex, runEntrypoint, combineRgb, TCPHelper } = require('@companion-module/base')

const paramFuncs = require('./paramFuncs')
const actionFuncs = require('./actions.js')
const varFuncs = require('./variables.js')
const upgrades = require('./upgrades')

const RCP_PORT = 49280
const MSG_DELAY = 5
const KA_INTERVAL = 10000

// Instance Setup
class Neutrik_DPRO extends InstanceBase {
	constructor(internal) {
		super(internal)
	}

	// Startup
	async init(cfg) {
		this.updateStatus(InstanceStatus.Connecting, 'Starting')
		global.config = cfg
		global.rcpCommands = []
		this.colorCommands = [] // Commands which have a color field
		this.rcpPresets = []
		this.dataStore = {} // status, Address (using ":"), X, Y, Val
		this.cmdQueue = [] // prefix, Address (using ":"), X, Y, Val
		this.queueTimer
		this.kaTimer = {}
		this.variables = []
		this.newDpro()
	}

	// Change in Configuration
	async configUpdated(cfg) {
		config = cfg
		this.newDpro()
	}

	// Module deletion
	async destroy() {
		clearTimeout(this.queueTimer)
		clearInterval(this.kaTimer)
		this.socket?.destroy()
		this.log('debug', `[${new Date().toJSON()}] destroyed ${this.id}`)
	}

	// Web UI config fields
	getConfigFields() {
		let config = [
			{
				type: 'dropdown',
				id: 'model',
				label: 'Device Type',
				width: 12,
				default: 'NA2-IO-DPRO',
				choices: [{ id: 'NA2-IO-DPRO', label: 'NA2-IO-DPRO' }],
				isVisible: () => false,
			},
			{
				type: 'bonjour-device',
				id: 'bonjour_host',
				label: 'Bonjour Address of Device',
				width: 6,
				default: '',
				regex: Regex.HOSTNAME,
			},
			{
				type: 'textinput',
				id: 'host',
				label: 'Control IP Address of Device',
				width: 6,
				default: '192.168.0.128',
				regex: Regex.IP,
				isVisible: (options) => !options.bonjour_host,
				tooltip: 'The DPRO has 2 interfaces, Control and Dante. The module can only connect to the control interface.',
			},
			{
				type: 'static-text',
				label: '',
				width: 6,
				isVisible: (options) => !!options.bonjour_host,
			},
		]
		return config
	}

	// Whenever the console type changes, update the info
	newDpro() {
		this.log('info', `Device selected: ${config.model}`)
		rcpCommands = paramFuncs.getParams(this, config)

		actionFuncs.updateActions(this) // Re-do the actions once the console is chosen
		varFuncs.initVars(this)
		this.createPresets()
		config.host = config.bonjour_host?.split(':')[0] || config.host
		this.initTCP()
	}

	// Initialize TCP
	initTCP() {
		let receiveBuffer = ''
		let receivedLines = []
		let receivedCmds = []
		let foundCmd = {}

		this.socket?.destroy()
		delete this.socket

		if (config.host) {
			this.socket = new TCPHelper(config.host, RCP_PORT)

			this.socket.on('status_change', (status, message) => {
				this.updateStatus(status, message)
			})

			this.socket.on('error', (err) => {
				this.log('error', `Network error: ${err.message}`)
				this.updateStatus(InstanceStatus.ConnectionFailure)
			})

			this.socket.on('connect', () => {
				this.log('info', `Connected!`)
				this.updateStatus(InstanceStatus.Ok)
				clearInterval(this.kaTimer)
				varFuncs.getVars(this)
				this.queueTimer = {}
				this.processCmdQueue()
				this.subscribeActions()
				this.subscribeFeedbacks()
				this.sendCmd(`scpmode keepalive ${KA_INTERVAL * 2}`) // Tell device to close connection after 2 * KA interval without RXing any messages
				this.kaTimer = setInterval(() => this.sendCmd('devstatus runmode'), KA_INTERVAL) // Send message on KA interval to ensure connection isn't closed
			})

			this.socket.on('data', (chunk) => {
				receiveBuffer += chunk
				receivedLines = receiveBuffer.split('\x0A') // Split by line break
				if (receivedLines.length == 0) {
					return // No messages
				}

				if (receiveBuffer.endsWith('\x0A')) {
					receiveBuffer = receivedLines[receivedLines.length - 1] // Broken line, leave it for next time...
					receivedLines.splice(receivedLines.length - 1) // Remove it.
				} else {
					receiveBuffer = ''
				}

				for (let line of receivedLines) {
					if (line.length == 0) {
						continue
					}
					this.log('debug', `[${new Date().toJSON()}] Received: '${line}'`)
					receivedCmds = paramFuncs.parseData(line) // Break out the parameters

					for (let i = 0; i < receivedCmds.length; i++) {
						let curCmd = JSON.parse(JSON.stringify(receivedCmds[i])) // deep clone
						foundCmd = paramFuncs.findRcpCmd(curCmd.Address, curCmd.Action) // Find which command

						switch (curCmd.Action) {
							case 'set':
							case 'get':
								if (foundCmd != undefined) {
									if (!(curCmd.Status == 'OK' && curCmd.Action == 'set')) {
										this.addToDataStore(curCmd)
									}

									if (this.isRecordingActions) {
										this.addToActionRecording({ rcpCmd: foundCmd, options: curCmd })
									}
								}
						}

						varFuncs.setVar(this, curCmd)
						this.processCmdQueue(curCmd)
					}
				}
			})
		}
	}

	// New Command (Action or Feedback) to Add
	addToCmdQueue(cmd) {
		clearTimeout(this.queueTimer)
		let cmdToAdd = JSON.parse(JSON.stringify(cmd)) // Deep Clone
		let rcpCmd = paramFuncs.findRcpCmd(cmdToAdd.Address)
		let i = this.cmdQueue.findIndex(
			(c) =>
				c.prefix == cmdToAdd.prefix &&
				c.Address == cmdToAdd.Address &&
				((c.X == cmdToAdd.X && c.Y == cmdToAdd.Y) || (rcpCmd.Action == 'mtrinfo' && c.Y == cmdToAdd.Y)),
		)
		if (i > -1) {
			this.cmdQueue[i] = cmdToAdd // Replace queued message with new one
		} else {
			this.cmdQueue.push(cmdToAdd)
		}

		if (this.queueTimer) {
			this.queueTimer = setTimeout(() => {
				this.processCmdQueue()
			}, MSG_DELAY)
		}
	}

	// When a message comes in from the console, match it up and delete it, and send the next message
	processCmdQueue(cmd) {
		clearTimeout(this.queueTimer)
		if (this.cmdQueue == undefined || this.cmdQueue.length == 0) return
		if (cmd != undefined) {
			let i = this.cmdQueue.findIndex(
				(c) => c.prefix == 'get' && c.Address == cmd.Address && c.X == cmd.X && c.Y == cmd.Y,
			)
			if (i > -1) {
				this.cmdQueue.splice(i, 1) // Got value from matching request so remove it!
			}
		}

		if (this.cmdQueue.length > 0) {
			// Messages still to send?
			let nextCmd = this.cmdQueue[0] // Oldest

			if (nextCmd.prefix == 'set') {
				let nextCmdVal = paramFuncs.parseVal(this, nextCmd)
				if (nextCmdVal == undefined) {
					this.cmdQueue.shift()
					this.cmdQueue.push(nextCmd)

					this.queueTimer = setTimeout(() => {
						this.processCmdQueue()
					}, MSG_DELAY)

					return
				}
				nextCmd.Val = nextCmdVal
			}

			let msg = paramFuncs.fmtCmd(nextCmd)
			if (this.sendCmd(msg)) {
				if (nextCmd.prefix == 'set') {
					this.addToDataStore(nextCmd) // Update to latest value
				}
			}

			this.cmdQueue.shift() // Get rid of message, whether sent or not
			this.queueTimer = setTimeout(() => {
				this.processCmdQueue()
			}, MSG_DELAY)
		}
	}

	// Create the preset definitions
	createPresets() {
		this.rcpPresets = []

		this.setPresetDefinitions(this.rcpPresets)
	}

	// Track whether actions are being recorded
	handleStartStopRecordActions(isRecording) {
		this.isRecordingActions = isRecording
	}

	// Add a command to the Action Recorder
	async addToActionRecording(c) {
		let aId = c.rcpCmd.Address.replace(/:/g, '_')
		let cX = parseInt(c.options.X) + 1
		let cY = parseInt(c.options.Y) + 1
		let cV

		switch (c.rcpCmd.Type) {
			case 'integer':
			case 'binary':
				cV = c.options.Val == -32768 ? '-Inf' : c.options.Val / c.rcpCmd.Scale
				break
			case 'freq':
				cV = c.options.Val / c.rcpCmd.Scale
				break
			case 'bool':
				cV = 'Toggle'
				break
			case 'string':
				cV = c.options.Val
				break
		}

		this.recordAction(
			{
				actionId: aId,
				options: { X: cX, Y: cY, Val: cV },
			},
			`${aId} ${cX} ${cY}`, // uniqueId to stop duplicates
		)
	}

	sendCmd(c) {
		if (c !== undefined) {
			c = c.trim()
			this.log(
				'debug',
				`[${new Date().toJSON()}] Sending :    '${c}' to ${this.getVariableValue('modelName')} @ ${config.host}`,
			)

			if (this.socket !== undefined && this.socket.isConnected) {
				this.socket.send(`${c}\n`) // send the message to the device
				return true
			}
			this.log('info', 'Socket not connected :(')
		}
		return false
	}

	// Poll the console for it's status to update buttons via feedback
	pollConsole() {
		//varFuncs.getVars(this)
		this.dataStore = {}
		this.subscribeActions()
		this.checkFeedbacks()
	}

	// Add a value to the dataStore
	addToDataStore(cmd) {
		const dsAddr = cmd.Address
		const dsX = cmd.X == undefined ? 0 : parseInt(cmd.X)
		const dsY = cmd.Y == undefined ? 0 : parseInt(cmd.Y)

		if (this.dataStore[dsAddr] == undefined) {
			this.dataStore[dsAddr] = {}
		}
		if (this.dataStore[dsAddr][dsX] == undefined) {
			this.dataStore[dsAddr][dsX] = {}
		}
		if (this.dataStore[dsAddr][dsX][dsY] != cmd.Val) {
			this.dataStore[dsAddr][dsX][dsY] = cmd.Val
			this.checkFeedbacks(dsAddr.replace(/:/g, '_')) // Make sure variables are updated
		}
	}

	// Get a value from the dataStore. If the value doesn't exist, send a request to get it.
	getFromDataStore(cmd) {
		let data = undefined
		if (cmd == undefined) return data

		if (cmd.Address !== undefined) {
			if (
				this.dataStore[cmd.Address] !== undefined &&
				this.dataStore[cmd.Address][cmd.X] !== undefined &&
				this.dataStore[cmd.Address][cmd.X][cmd.Y] !== undefined
			) {
				data = this.dataStore[cmd.Address][cmd.X][cmd.Y]
				return data
			}
			let rcpCmd = paramFuncs.findRcpCmd(cmd.Address)
			if (rcpCmd !== undefined && rcpCmd.RW.includes('r')) {
				cmd.prefix = 'get'
				this.addToCmdQueue(cmd)
			}
		}

		return data
	}
}

runEntrypoint(Neutrik_DPRO, upgrades)
