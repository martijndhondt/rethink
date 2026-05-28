import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { ERRORS, STATES, COURSES, TEMPERATURES, SPINS } from './washer_common'

// F_C__Y___W.A__QEUK — LG front-loading washer, A-generation UK
// 62-byte AABB status packet (0x20 0xEC subtype).
// Offsets confirmed from live captures against known settings:
//   Cotton/40°C/1400RPM/Normal-rinse, delayed-start 4h, tub-clean-counter=9, remote-start=off.
export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Washer' }),
                components: {
                    power: {
                        platform: 'switch',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        command_topic: '$this/power/set',
                        name: '',
                        icon: 'mdi:washing-machine',
                    },
                    start: {
                        platform: 'button',
                        unique_id: '$deviceid-start',
                        command_topic: '$this/start/set',
                        payload_press: '',
                        name: 'Start',
                        icon: 'mdi:play-circle-outline',
                    },
                    pause: {
                        platform: 'button',
                        unique_id: '$deviceid-pause',
                        command_topic: '$this/pause/set',
                        payload_press: '',
                        name: 'Pause',
                        icon: 'mdi:pause-circle-outline',
                    },
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Status',
                        icon: 'mdi:state-machine',
                        device_class: 'enum',
                        options: STATES.filter((a) => a !== undefined),
                    },
                    error: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-error',
                        state_topic: '$this/error',
                        name: 'Error',
                        icon: 'mdi:check-circle',
                        device_class: 'problem',
                        entity_category: 'diagnostic',
                    },
                    error_message: {
                        platform: 'sensor',
                        unique_id: '$deviceid-error-message',
                        state_topic: '$this/error_message',
                        name: 'Error message',
                        icon: 'mdi:alert-circle-outline',
                        device_class: 'enum',
                        entity_category: 'diagnostic',
                        options: ERRORS.filter((a) => a !== undefined),
                    },
                    course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-course',
                        state_topic: '$this/course',
                        name: 'Course',
                        icon: 'mdi:pin-outline',
                    },
                    temp: {
                        platform: 'sensor',
                        unique_id: '$deviceid-temp',
                        state_topic: '$this/temp',
                        name: 'Temperature',
                        device_class: 'temperature',
                        unit_of_measurement: '°C',
                        suggested_display_precision: 0,
                        value_template: "{{ value if value | is_number else 'None' }}",
                    },
                    spin: {
                        platform: 'sensor',
                        unique_id: '$deviceid-spin',
                        state_topic: '$this/spin',
                        name: 'Spin',
                        icon: 'mdi:autorenew',
                        unit_of_measurement: 'RPM',
                        value_template: "{{ value if value | is_number else 'None' }}",
                    },
                    remote_start: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-remote_start',
                        state_topic: '$this/remote_start',
                        name: 'Remote start',
                        icon: 'mdi:play-circle-outline',
                    },
                    door_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-door_lock',
                        state_topic: '$this/door_lock',
                        name: 'Door lock',
                        device_class: 'lock',
                    },
                    tub_clean: {
                        platform: 'sensor',
                        unique_id: '$deviceid-tub-clean',
                        state_topic: '$this/tub_clean',
                        name: 'Tub clean counter',
                        icon: 'mdi:washing-machine-alert',
                        entity_category: 'diagnostic',
                    },
                    initial_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-initial_time',
                        state_topic: '$this/initial_time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        name: 'Initial time',
                    },
                    remaining_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-remaining_time',
                        state_topic: '$this/remaining_time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        name: 'Remaining time',
                    },
                    delay_remaining: {
                        platform: 'sensor',
                        unique_id: '$deviceid-delay_remaining',
                        state_topic: '$this/delay_remaining',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        name: 'Delay remaining',
                        icon: 'mdi:clock-start',
                    },
                },
            }),
        )
    }

    start() {
        this.send(Buffer.from('F0ED1121010000001800', 'hex'))
    }

    processAABB(buf: Buffer) {
        // Log every packet — remove once error/energy offsets are confirmed
        console.log(`[F_C__Y___W.A__QEUK] AABB packet (${buf.length} bytes): ${buf.toString('hex')}`)

        // 0xEC = 62-byte dual-section status packet (normal polling response)
        // 0xEB = 32-byte single-section compact packet (sent after commands/reconnect)
        // Both share the same field layout in their first section.
        // 0xE2 = 32-byte end-of-cycle alert packet: floods at ~2s intervals during End
        //        state. Has different field layout ([4]≠status, [5][6]≠time); [12][13][14]
        //        and [25] coincidentally sit at the same offsets but [4]=0x04='Measuring'
        //        would be wrong to publish. Silently ignored.
        const isEC = buf.length === 62 && buf[0] === 0x20 && buf[1] === 0xec
        const isEB = buf.length === 32 && buf[0] === 0x20 && buf[1] === 0xeb
        const isE2 = buf.length === 32 && buf[0] === 0x20 && buf[1] === 0xe2
        if (isE2) return

        if (isEC || isEB) {
            // Confirmed offsets (A-gen status packet — both 0xEC and 0xEB):
            //   [4]     status           — STATES[3]='Delayed' confirmed
            //   [5][6]  remaining_time   — counts down during wash; equals initial when delayed
            //                            NOTE: shows 0 briefly at wash start (load-measuring phase)
            //   [7][8]  initial_time     — fixed total program duration (72 min confirmed, stays constant)
            //   [9]     lock_status      — bit1=remote_start (ON when set), bit6=door_lock (ON=unlocked when set)
            //   [12]    spin index       — SPINS[10]=1400 RPM confirmed
            //   [13]    temp index       — TEMPERATURES[4]=40°C confirmed
            //   [14]    course           — COURSES[0x01]='Cotton' confirmed
            //   [16]    delay hours      — 4 confirmed
            //   [17]    delay minutes    — counts down 1/min confirmed
            //   [22]    0x06 constant    — protocol marker
            //   [23]    status echo      — mirrors buf[4], confirmed across Delayed/Washing/Rinsing
            //   [25]    tub_clean        — 9 during wash; increments to 10 on End packet confirmed (NOTE: NOT buf[26])
            // The 62-byte 0xEC packet has a second half [33..61] mirroring [2..30]
            // with [48]=[17]-1 (previous reading, ignored).
            // End state: status=0x0A, spin/temp/course all go to 0x00 → 'unknown', remaining=0, tub_clean++.
            // Power stays ON during End (status>0); goes OFF only when status=0x00 ('Off').
            // TODO: error byte offset — needs a packet with an active error.
            const status = buf[4]
            const remain_h = buf[5]  // remaining_time hours (counts down; 0 briefly during load-measuring)
            const remain_m = buf[6]  // remaining_time minutes
            const initial_h = buf[7] // initial_time hours (fixed for the lifetime of the program)
            const initial_m = buf[8] // initial_time minutes
            const lock_status = buf[9]
            const spin = buf[12]
            const temp = buf[13]     // 0x00 during rinse (cold water) → publishes 'unknown', expected
            const course = buf[14]
            const delay_h = buf[16]
            const delay_m = buf[17]
            const tub_clean = buf[25] // confirmed at buf[25], not buf[26]

            this.publishProperty('power', status > 0 ? 'ON' : 'OFF')
            this.publishProperty('status', STATES[status] ?? 'unknown')
            this.publishProperty('course', COURSES[course] ?? 'unknown')
            this.publishProperty('spin', SPINS[spin] ?? 'unknown')
            this.publishProperty('temp', TEMPERATURES[temp] ?? 'unknown')
            this.publishProperty('remaining_time', remain_h * 60 + remain_m)
            this.publishProperty('initial_time', initial_h * 60 + initial_m)
            this.publishProperty('delay_remaining', delay_h * 60 + delay_m)
            this.publishProperty('remote_start', lock_status & 2 ? 'ON' : 'OFF')
            this.publishProperty('door_lock', lock_status & 0x40 ? 'ON' : 'OFF')
            this.publishProperty('tub_clean', tub_clean)
        }
    }

    setProperty(prop: string, mqttValue: string) {
        if (prop === 'power') {
            if (mqttValue === 'ON') {
                this.send(Buffer.from('F02A0100', 'hex'))
            } else if (mqttValue === 'OFF') {
                this.send(Buffer.from('F024010100', 'hex'))
            }
        }

        if (prop === 'pause') this.send(Buffer.from('F024040100', 'hex'))
        if (prop === 'start') this.send(Buffer.from(mqttValue || 'F024050100', 'hex'))
    }
}
