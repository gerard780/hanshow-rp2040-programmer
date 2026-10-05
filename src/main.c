#include <string.h>
#include "pico/stdlib.h"
#include "pico/multicore.h"
#include "pico/bootrom.h"
#include "hardware/clocks.h"
#include "hardware/pio.h"
#include "hardware/uart.h"
#include "hardware/dma.h"
#include "tusb.h"
#include "serial.pio.h"

enum { SWS_TX = 0, SWS_RX = 1, TAG_RESET = 2, TAG_TX = 4, TAG_RX = 5 };
enum { TX_SM = 0, RX_SM = 1, RING_SIZE = 32768, RING_MASK = RING_SIZE - 1 };

// Each ring has exactly one producer and one consumer, on different cores.
// Aligned 32-bit indexes are atomic on RP2040; DMB orders buffer/index publication.
typedef struct {
    uint8_t bytes[RING_SIZE];
    volatile uint32_t write, read;
} ring_t;
static ring_t usb_to_serial[2], serial_to_usb[2];
static volatile uint32_t requested_baud[2] = {921600, 115200};
static volatile bool requested_open[2], hardware_open[2];
static volatile uint32_t dropped[2], rx_count[2], tx_count[2];
static volatile bool reset_asserted;
static bool boot_requested;
static uint tx_offset, rx_offset, reply_offset, request_offset;
static uint trace_offset, trace_dma;
static uint32_t trace_buffer[256];
// Keep the longer reply program beside the tracer on PIO1. PIO0 retains the
// UART command/echo programs and the request pulse. GP1 switches mux when the
// receiver changes; GP0 stays on PIO0 throughout.
enum { REPLY_SM = 1 };
static bool native_rx_active, native_tx_active;

static void trace_start(void) {
    pio_sm_set_enabled(pio1, 0, false);
    dma_channel_abort(trace_dma);
    pio_sm_config c = bus_trace_program_get_default_config(trace_offset);
    sm_config_set_in_pins(&c, SWS_RX);
    sm_config_set_in_shift(&c, true, true, 32);
    sm_config_set_fifo_join(&c, PIO_FIFO_JOIN_RX);
    sm_config_set_clkdiv(&c, (float)clock_get_hz(clk_sys) / 8000000.0f);
    pio_sm_init(pio1, 0, trace_offset, &c);
    dma_channel_config dc = dma_channel_get_default_config(trace_dma);
    channel_config_set_transfer_data_size(&dc, DMA_SIZE_32);
    channel_config_set_read_increment(&dc, false);
    channel_config_set_write_increment(&dc, true);
    channel_config_set_dreq(&dc, pio_get_dreq(pio1, 0, false));
    dma_channel_configure(trace_dma, &dc, trace_buffer, &pio1->rxf[0], 256, true);
    pio_sm_set_enabled(pio1, 0, true);
}
// Outgoing bytes are the upstream reader's ten UART characters per SWS byte.
// Track read headers so single-byte read triggers can use native pulse capture.
static uint8_t encoded_frame[10];
static uint frame_used, header_left;
static uint32_t frame_history[128], frame_index;
static bool sws_read_mode, reply_pending, reply_ready;
// Legacy 825x/827x uses 3 address bytes; 826x uses 2.
static volatile uint32_t sws_address_bytes = 3;
static uint8_t reply_byte;
static uint64_t reply_deadline;
enum { BLOCK_IDLE, BLOCK_BUSY, BLOCK_DONE, BLOCK_ERROR, BLOCK_CAPACITY = 4096 };
static uint8_t block_buffer[BLOCK_CAPACITY];
// Core 0 publishes a count before BUSY; core 1 publishes data before DONE.
static volatile uint32_t block_state, block_count, block_completed;
static volatile bool block_cancel;
static bool reply_is_block;

static bool tag_uart_busy(void) {
    return (uart_get_hw(uart1)->fr & UART_UARTFR_BUSY_BITS) != 0;
}

static bool ring_put(ring_t *ring, uint8_t byte) {
    uint32_t next = (ring->write + 1) & RING_MASK;
    if (next == ring->read) return false;
    __dmb();
    ring->bytes[ring->write] = byte;
    __dmb();
    ring->write = next;
    return true;
}
static bool ring_get(ring_t *ring, uint8_t *byte) {
    if (ring->read == ring->write) return false;
    __dmb();
    *byte = ring->bytes[ring->read];
    __dmb();
    ring->read = (ring->read + 1) & RING_MASK;
    return true;
}
static bool ring_peek(ring_t *ring, uint8_t *byte) {
    if (ring->read == ring->write) return false;
    // Acquire the producer's publication before looking at the next byte.
    __dmb();
    *byte = ring->bytes[ring->read];
    return true;
}
static uint32_t ring_space(const ring_t *ring) {
    return (ring->read - ring->write - 1) & RING_MASK;
}

static void release_pin(uint pin) {
    gpio_init(pin);
    gpio_set_dir(pin, GPIO_IN);
    gpio_disable_pulls(pin);
}

static void sws_uart_receiver(uint32_t baud) {
    pio_sm_set_enabled(pio1, REPLY_SM, false);
    native_rx_active = false;
    pio_sm_set_enabled(pio0, RX_SM, false);
    pio_sm_config rx = bridge_rx_program_get_default_config(rx_offset);
    sm_config_set_in_pins(&rx, SWS_RX);
    sm_config_set_jmp_pin(&rx, SWS_RX);
    sm_config_set_in_shift(&rx, true, false, 32);
    sm_config_set_fifo_join(&rx, PIO_FIFO_JOIN_RX);
    sm_config_set_clkdiv(&rx, (float)clock_get_hz(clk_sys) / (8.0f * baud));
    pio_sm_init(pio0, RX_SM, rx_offset, &rx);
    pio_sm_set_consecutive_pindirs(pio0, RX_SM, SWS_RX, 1, false);
    pio_gpio_init(pio0, SWS_RX);
    gpio_pull_up(SWS_RX);
    pio_sm_set_enabled(pio0, RX_SM, true);
}

static void sws_reply_receiver(void) {
    pio_sm_set_enabled(pio0, RX_SM, false);
    if (native_rx_active) {
        // The previous reply has been consumed and this machine is parked.
        // Jump to its entry; the next eight shifts replace the previous byte.
        pio_sm_exec(pio1, REPLY_SM, pio_encode_jmp(reply_offset));
        return;
    }
    pio_sm_set_enabled(pio1, REPLY_SM, false);
    pio_sm_config rx = swire_reply_program_get_default_config(reply_offset);
    sm_config_set_in_pins(&rx, SWS_RX);
    sm_config_set_jmp_pin(&rx, SWS_RX);
    sm_config_set_in_shift(&rx, false, false, 32);
    sm_config_set_fifo_join(&rx, PIO_FIFO_JOIN_RX);
    // Run at the system clock: decoding depends on pulse ratio, not baud rate.
    pio_sm_init(pio1, REPLY_SM, reply_offset, &rx);
    pio_sm_set_consecutive_pindirs(pio1, REPLY_SM, SWS_RX, 1, false);
    pio_gpio_init(pio1, SWS_RX);
    pio_sm_set_enabled(pio1, REPLY_SM, true);
    native_rx_active = true;
}

static void sws_track_byte(uint8_t byte) {
    encoded_frame[frame_used++] = byte;
    if (frame_used != sizeof(encoded_frame)) return;
    frame_used = 0;
    uint8_t value = 0;
    for (uint bit = 1; bit <= 8; ++bit) {
        if (encoded_frame[bit] != 0x80 && encoded_frame[bit] != 0xfe) {
            sws_read_mode = false;
            header_left = 0;
            return;
        }
        value = (value << 1) | (encoded_frame[bit] == 0x80);
    }
    if (encoded_frame[0] == 0x80) {
        sws_read_mode = false;
        header_left = value == 0x5a ? sws_address_bytes + 1 : 0;
    } else if (header_left) {
        --header_left;
        if (!header_left) sws_read_mode = (value & 0x80) != 0;
    }
    frame_history[frame_index++ & 127] = value |
        ((encoded_frame[0] == 0x80) << 8) | (header_left << 16) | (sws_read_mode << 24);
}

static void sws_uart_transmitter(uint32_t baud) {
    native_tx_active = false;
    pio_sm_set_enabled(pio0, TX_SM, false);
    pio_sm_config tx = bridge_tx_program_get_default_config(tx_offset);
    sm_config_set_out_shift(&tx, true, false, 32);
    sm_config_set_out_pins(&tx, SWS_TX, 1);
    sm_config_set_sideset_pins(&tx, SWS_TX);
    sm_config_set_fifo_join(&tx, PIO_FIFO_JOIN_TX);
    sm_config_set_clkdiv(&tx, (float)clock_get_hz(clk_sys) / (8.0f * baud));
    pio_sm_init(pio0, TX_SM, tx_offset, &tx);
    pio_sm_set_pins_with_mask(pio0, TX_SM, 1u << SWS_TX, 1u << SWS_TX);
    pio_sm_set_consecutive_pindirs(pio0, TX_SM, SWS_TX, 1, true);
    pio_gpio_init(pio0, SWS_TX);
    // Retain pull-ups on both pins; TX stays high through the series resistor
    // while the tag drives its reply on the directly connected RX pin.
    gpio_pull_up(SWS_TX);
    gpio_set_drive_strength(SWS_TX, GPIO_DRIVE_STRENGTH_4MA);
    pio_sm_set_enabled(pio0, TX_SM, true);
}

static void sws_request_pulse(uint32_t baud) {
    if (native_tx_active) {
        pio_sm_exec(pio0, TX_SM, pio_encode_jmp(request_offset));
        return;
    }
    gpio_set_drive_strength(SWS_TX, GPIO_DRIVE_STRENGTH_2MA);
    pio_sm_set_enabled(pio0, TX_SM, false);
    pio_sm_config tx = swire_request_program_get_default_config(request_offset);
    sm_config_set_set_pins(&tx, SWS_TX, 1);
    // 64 PIO cycles low = two UART bit times, matching a short-low trigger.
    sm_config_set_clkdiv(&tx, (float)clock_get_hz(clk_sys) / (32.0f * baud));
    pio_sm_init(pio0, TX_SM, request_offset, &tx);
    pio_sm_set_enabled(pio0, TX_SM, true);
    native_tx_active = true;
}

static void sws_start(uint32_t baud) {
    sws_uart_transmitter(baud);
    sws_uart_receiver(baud);
    frame_used = header_left = 0;
    sws_read_mode = reply_pending = reply_ready = false;
}

static void serial_start(uint port, uint32_t baud) {
    if (port == 0) {
        pio_sm_set_enabled(pio1, REPLY_SM, false);
        native_rx_active = native_tx_active = false;
        sws_start(baud);
    } else {
        uart_init(uart1, baud);
        uart_set_format(uart1, 8, 1, UART_PARITY_NONE);
        uart_set_hw_flow(uart1, false, false);
        uart_set_fifo_enabled(uart1, true);
        gpio_set_function(TAG_TX, GPIO_FUNC_UART);
        gpio_set_function(TAG_RX, GPIO_FUNC_UART);
    }
}
static void serial_stop(uint port) {
    if (port == 0) {
        pio_sm_set_enabled(pio1, REPLY_SM, false);
        native_rx_active = native_tx_active = false;
        pio_sm_set_enabled(pio0, TX_SM, false);
        pio_sm_set_enabled(pio0, RX_SM, false);
        release_pin(SWS_TX);
        release_pin(SWS_RX);
    } else {
        uart_deinit(uart1);
        release_pin(TAG_TX);
        release_pin(TAG_RX);
    }
}

static void serial_core(void) {
    uint32_t baud[2] = {0, 0};
    uint64_t tx_guard[2] = {0, 0};
    for (;;) {
        for (uint port = 0; port < 2; ++port) {
            bool open = requested_open[port];
            uint32_t next_baud = requested_baud[port];
            bool idle = !hardware_open[port] || (port == 0
                ? !reply_pending && block_state != BLOCK_BUSY &&
                  pio_sm_is_tx_fifo_empty(pio0, TX_SM) && time_us_64() >= tx_guard[port]
                : !tag_uart_busy());
            if (open && (!hardware_open[port] || next_baud != baud[port]) && idle) {
                serial_start(port, next_baud);
                baud[port] = next_baud;
                hardware_open[port] = true;
            }
            if (!hardware_open[port]) {
                if (port == 0 && block_state == BLOCK_BUSY) {
                    __dmb();
                    block_state = BLOCK_ERROR;
                }
                continue;
            }
            if (port == 0 && reply_pending) {
                if (!reply_ready && !pio_sm_is_rx_fifo_empty(pio1, REPLY_SM)) {
                    reply_byte = (uint8_t)pio_sm_get(pio1, REPLY_SM);
                    reply_ready = true;
                }
                if (reply_ready) {
                    if (reply_is_block) {
                        block_buffer[block_completed] = reply_byte;
                        __dmb();
                        ++block_completed;
                        if (block_cancel || block_completed == block_count) {
                            __dmb();
                            block_state = block_cancel ? BLOCK_ERROR : BLOCK_DONE;
                            sws_uart_transmitter(baud[0]);
                            sws_uart_receiver(baud[0]);
                        }
                        ++rx_count[0];
                    } else {
                        sws_uart_transmitter(baud[0]);
                        sws_uart_receiver(baud[0]);
                        // Preserve the legacy reader's nine sample bytes.
                        for (uint bit = 0; bit < 8; ++bit) {
                            uint8_t sample = reply_byte & (0x80u >> bit) ? 0x80 : 0xfe;
                            if (!ring_put(&serial_to_usb[0], sample)) ++dropped[0];
                        }
                        if (!ring_put(&serial_to_usb[0], 0xfe)) ++dropped[0];
                        rx_count[0] += 9;
                    }
                    reply_pending = reply_ready = false;
                } else if (time_us_64() >= reply_deadline) {
                    sws_uart_transmitter(baud[0]);
                    sws_uart_receiver(baud[0]);
                    reply_pending = reply_ready = false;
                    ++dropped[0]; // Count an unanswered request as a transport fault.
                    if (reply_is_block) { __dmb(); block_state = BLOCK_ERROR; }
                }
                // Service the other UART while waiting for this reply.
                continue;
            }
            if (port == 0 && block_state == BLOCK_BUSY) {
                __dmb();
                if (block_cancel || !sws_read_mode || frame_used || next_baud != baud[0]) {
                    sws_uart_transmitter(baud[0]);
                    sws_uart_receiver(baud[0]);
                    block_state = BLOCK_ERROR;
                    continue;
                }
                if (!pio_sm_is_tx_fifo_empty(pio0, TX_SM) || time_us_64() < tx_guard[0]) continue;
                sws_reply_receiver();
                if (!block_completed) trace_start();
                sws_request_pulse(baud[0]);
                ++tx_count[0];
                reply_is_block = reply_pending = true;
                reply_ready = false;
                reply_deadline = time_us_64() + 50000;
                continue;
            }
            while (port == 0 ? !pio_sm_is_rx_fifo_empty(pio0, RX_SM) : uart_is_readable(uart1)) {
                uint8_t byte = port == 0 ? (uint8_t)(pio_sm_get(pio0, RX_SM) >> 24)
                                        : (uint8_t)uart_getc(uart1);
                ++rx_count[port];
                if (!ring_put(&serial_to_usb[port], byte)) ++dropped[port];
            }
            // Do not feed more bytes until a requested baud change has applied.
            if (next_baud == baud[port]) {
                while (port == 0 ? !pio_sm_is_tx_fifo_full(pio0, TX_SM) : uart_is_writable(uart1)) {
                    uint8_t byte;
                    uint8_t peek;
                    // Peek once before deciding how to consume this byte. If
                    // empty, stop: a publication between peek and get must not
                    // bypass native read-trigger classification.
                    if (!ring_peek(&usb_to_serial[port], &peek)) break;
                    if (port == 0 && sws_read_mode && frame_used == 0 && peek == 0xfe) {
                        // Header echo must finish before switching receiver.
                        if (!pio_sm_is_tx_fifo_empty(pio0, TX_SM) || time_us_64() < tx_guard[0]) break;
                        sws_reply_receiver();
                        trace_start();
                        if (!ring_get(&usb_to_serial[0], &byte)) {
                            sws_uart_receiver(baud[0]);
                            break;
                        }
                        sws_request_pulse(baud[0]);
                        ++tx_count[0];
                        frame_history[frame_index++ & 127] = 0x800000fe;
                        reply_pending = true;
                        reply_is_block = false;
                        reply_ready = false;
                        reply_deadline = time_us_64() + 50000;
                        tx_guard[0] = time_us_64() + (10000000ull + baud[0] - 1) / baud[0] + 2;
                        break;
                    }
                    if (!ring_get(&usb_to_serial[port], &byte)) break;
                    if (port == 0) {
                        pio_sm_put(pio0, TX_SM, byte);
                        sws_track_byte(byte);
                        // FIFO has eight entries plus an in-flight character.
                        tx_guard[port] = time_us_64() + (10000000ull * 9 + baud[port] - 1) / baud[port] + 2;
                    } else {
                        uart_get_hw(uart1)->dr = byte;
                    }
                    ++tx_count[port];
                }
            }
            // Recheck after feeding TX: the earlier idle snapshot is now stale.
            bool drained = port == 0
                ? pio_sm_is_tx_fifo_empty(pio0, TX_SM) && time_us_64() >= tx_guard[port]
                : !tag_uart_busy();
            if (!open && usb_to_serial[port].read == usb_to_serial[port].write && drained) {
                serial_stop(port);
                hardware_open[port] = false;
            }
        }
        tight_loop_contents();
    }
}

void tud_cdc_line_coding_cb(uint8_t port, const cdc_line_coding_t *coding) {
    if (port >= 2) return;
    // This transport implements 8N1 only. Keep the previous rate on invalid input.
    if (coding->data_bits != 8 || coding->parity != 0 || coding->stop_bits != 0) return;
    uint32_t minimum = port == 0 ? 340000 : 1200;
    if (coding->bit_rate >= minimum && coding->bit_rate <= 3000000)
        requested_baud[port] = coding->bit_rate;
}
void tud_cdc_line_state_cb(uint8_t port, bool dtr, bool rts) {
    if (port >= 2) return;
    if (dtr) {
        // Discard stale input on reopen; this core owns the consumer index.
        serial_to_usb[port].read = serial_to_usb[port].write;
    }
    // pvvx activate() deasserts DTR before transmitting. A real CH340 keeps
    // transmitting then, so SWS must remain active across DTR/RTS transitions.
    if (port == 0) {
        if (dtr) requested_open[port] = true;
    } else {
        requested_open[port] = dtr;
    }
#if ENABLE_TAG_RESET
    if (port == 0) {
        gpio_put(TAG_RESET, false);
        gpio_set_dir(TAG_RESET, dtr && rts ? GPIO_OUT : GPIO_IN);
        reset_asserted = dtr && rts;
    }
#else
    (void)rts;
#endif
}
void tud_umount_cb(void) {
    block_cancel = true;
    requested_open[0] = requested_open[1] = false;
    gpio_set_dir(TAG_RESET, GPIO_IN);
    reset_asserted = false;
}

// Read-only diagnostics use endpoint zero, so no text contaminates SWS data.
// Request 0x01 returns ten LE uint32 values; request 0xb0 returns to BOOTSEL.
extern bool bridge_ms_os_request(uint8_t rhport, uint8_t stage, const tusb_control_request_t *request);
bool tud_vendor_control_xfer_cb(uint8_t rhport, uint8_t stage, const tusb_control_request_t *request) {
    static uint32_t status[10];
    if (request->bmRequestType_bit.type != TUSB_REQ_TYPE_VENDOR) return false;
    if (request->bRequest == 0x21 && request->wIndex == 0) {
        if (request->bmRequestType == 0xc0 && request->wValue == 0 && request->wLength == 4) {
            static uint32_t width;
            if (stage == CONTROL_STAGE_SETUP) {
                width = sws_address_bytes;
                return tud_control_xfer(rhport, request, &width, sizeof(width));
            }
            return true;
        }
        if (request->bmRequestType == 0x40 && request->wLength == 0) {
            if (stage == CONTROL_STAGE_SETUP) {
                if ((request->wValue != 2 && request->wValue != 3) ||
                    requested_open[0] || hardware_open[0] || block_state == BLOCK_BUSY ||
                    usb_to_serial[0].read != usb_to_serial[0].write) return false;
                sws_address_bytes = request->wValue;
                __dmb();
                return tud_control_status(rhport, request);
            }
            return true;
        }
        return false;
    }
    if (request->bRequest == 0x30) return bridge_ms_os_request(rhport, stage, request);
    if (request->bRequest == 0x10 && request->bmRequestType == 0x40 &&
        request->wIndex == 0 && request->wLength == 0) {
        if (stage == CONTROL_STAGE_SETUP) {
            if (!request->wValue || request->wValue > BLOCK_CAPACITY ||
                block_state == BLOCK_BUSY) return false;
            block_count = request->wValue;
            block_completed = 0;
            block_cancel = false;
            __dmb();
            block_state = BLOCK_BUSY;
            return tud_control_status(rhport, request);
        }
        return true;
    }
    if (request->bRequest == 0x11 && request->bmRequestType == 0xc0) {
        static uint32_t response[2];
        if (stage == CONTROL_STAGE_SETUP) {
            uint32_t state = block_state;
            __dmb();
            response[0] = state;
            response[1] = block_completed;
            return tud_control_xfer(rhport, request, response, sizeof(response));
        }
        return true;
    }
    if (request->bRequest == 0x13 && request->bmRequestType == 0xc0 && request->wIndex == 0) {
        static uint8_t response[BLOCK_CAPACITY];
        if (stage == CONTROL_STAGE_SETUP) {
            uint32_t state = block_state;
            __dmb();
            uint32_t count = block_completed;
            // USB status and payload are separate so a 4 KiB payload stays
            // within Linux usbfs's control-transfer limit.
            if ((state != BLOCK_DONE && state != BLOCK_ERROR) ||
                request->wValue > count || request->wLength > count - request->wValue) return false;
            memcpy(response, block_buffer + request->wValue, request->wLength);
            return tud_control_xfer(rhport, request, response, request->wLength);
        }
        return true;
    }
    if (request->bRequest == 0x12 && request->bmRequestType == 0x40 && request->wLength == 0) {
        if (stage == CONTROL_STAGE_SETUP) {
            block_cancel = true;
            return tud_control_status(rhport, request);
        }
        return true;
    }
    if (request->bRequest == 0x03 && request->bmRequestType == 0xc0) {
        static uint32_t history[129];
        if (stage == CONTROL_STAGE_SETUP) {
            history[0] = frame_index;
            memcpy(history + 1, frame_history, sizeof(frame_history));
            return tud_control_xfer(rhport, request, history, sizeof(history));
        }
        return true;
    }
    if (request->bRequest == 0x02 && request->bmRequestType == 0xc0) {
        if (stage == CONTROL_STAGE_SETUP) {
            if (dma_channel_is_busy(trace_dma)) return false;
            return tud_control_xfer(rhport, request, trace_buffer, sizeof(trace_buffer));
        }
        return true;
    }
    if (request->bRequest == 0x01 && request->bmRequestType == 0xc0) {
        if (stage == CONTROL_STAGE_SETUP) {
            status[0] = 0x31505348; // "HSP1"
            status[1] = 0x00010005;
            status[2] = ENABLE_TAG_RESET | (reset_asserted << 1) |
                (hardware_open[0] << 2) | (hardware_open[1] << 3);
            status[3] = requested_baud[0]; status[4] = requested_baud[1];
            status[5] = rx_count[0]; status[6] = tx_count[0]; status[7] = dropped[0];
            status[8] = rx_count[1]; status[9] = dropped[1];
            return tud_control_xfer(rhport, request, status, sizeof(status));
        }
        return true;
    }
    if (request->bRequest == 0xb0 && request->bmRequestType == 0x40 &&
        request->wValue == 0xb007 && request->wLength == 0) {
        if (stage == CONTROL_STAGE_SETUP) return tud_control_status(rhport, request);
        if (stage == CONTROL_STAGE_ACK) boot_requested = true;
        return true;
    }
    return false;
}

static void usb_pump(uint port) {
    // Also support a host that sends SWS data without ever asserting DTR.
    if (port == 0 && tud_cdc_n_available(port)) requested_open[port] = true;
    if (!requested_open[port]) return;
    uint8_t buffer[64];
    uint32_t count = tud_cdc_n_available(port);
    uint32_t space = ring_space(&usb_to_serial[port]);
    // Bound hardware TX backlog to less than one USB packet. Large queues make
    // CDC tcdrain return long before SWS activation has actually finished.
    uint32_t pending = (usb_to_serial[port].write - usb_to_serial[port].read) & RING_MASK;
    uint32_t tx_space = pending < 63 ? 63 - pending : 0;
    if (space > tx_space) space = tx_space;
    if (count > space) count = space;
    if (count > sizeof(buffer)) count = sizeof(buffer);
    if (count) {
        count = tud_cdc_n_read(port, buffer, count);
        for (uint32_t i = 0; i < count; ++i) ring_put(&usb_to_serial[port], buffer[i]);
    }
    count = tud_cdc_n_write_available(port);
    if (count > sizeof(buffer)) count = sizeof(buffer);
    uint32_t used = 0;
    while (used < count && ring_get(&serial_to_usb[port], &buffer[used])) ++used;
    if (used) {
        // Only core0 writes this FIFO and space was checked above.
        tud_cdc_n_write(port, buffer, used);
        tud_cdc_n_write_flush(port);
    }
}

int main(void) {
    release_pin(SWS_TX); release_pin(SWS_RX); release_pin(TAG_RESET);
    release_pin(TAG_TX); release_pin(TAG_RX);
    tx_offset = pio_add_program(pio0, &bridge_tx_program);
    rx_offset = pio_add_program(pio0, &bridge_rx_program);
    reply_offset = pio_add_program(pio1, &swire_reply_program);
    request_offset = pio_add_program(pio0, &swire_request_program);
    trace_offset = pio_add_program(pio1, &bus_trace_program);
    trace_dma = dma_claim_unused_channel(true);
    tusb_init();
    multicore_launch_core1(serial_core);
    for (;;) {
        tud_task();
        usb_pump(0); usb_pump(1);
        if (boot_requested) {
            multicore_reset_core1();
            serial_stop(0); serial_stop(1); release_pin(TAG_RESET);
            reset_usb_boot(0, 0);
        }
    }
}
