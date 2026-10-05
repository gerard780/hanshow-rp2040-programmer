#include <string.h>
#include "pico/unique_id.h"
#include "tusb.h"

// TinyUSB's example VID/PID, for a prototype, not a registered product.
static const tusb_desc_device_t device = {
    .bLength = sizeof(tusb_desc_device_t), .bDescriptorType = TUSB_DESC_DEVICE,
    .bcdUSB = 0x0210, .bDeviceClass = TUSB_CLASS_MISC,
    .bDeviceSubClass = MISC_SUBCLASS_COMMON, .bDeviceProtocol = MISC_PROTOCOL_IAD,
    .bMaxPacketSize0 = CFG_TUD_ENDPOINT0_SIZE,
    .idVendor = 0xcafe, .idProduct = 0x4012, .bcdDevice = 0x0105,
    .iManufacturer = 1, .iProduct = 2, .iSerialNumber = 3, .bNumConfigurations = 1
};
const uint8_t *tud_descriptor_device_cb(void) { return (const uint8_t *)&device; }

static const uint8_t configuration[] = {
    TUD_CONFIG_DESCRIPTOR(1, 5, 0, TUD_CONFIG_DESC_LEN + 2 * TUD_CDC_DESC_LEN + 9, 0, 250),
    TUD_CDC_DESCRIPTOR(0, 4, 0x81, 16, 0x02, 0x82, 64),
    TUD_CDC_DESCRIPTOR(2, 5, 0x83, 16, 0x04, 0x84, 64),
    // A control-only vendor interface for browser block capture. Leave both
    // CDC interfaces on their normal OS drivers; no bulk endpoints are needed.
    9, TUSB_DESC_INTERFACE, 4, 0, 0, TUSB_CLASS_VENDOR_SPECIFIC, 0, 0, 6
};
const uint8_t *tud_descriptor_configuration_cb(uint8_t index) {
    (void)index;
    return configuration;
}

// Microsoft OS 2.0 descriptors bind only interface 4 to WinUSB on Windows.
// Layout follows TinyUSB's MIT-licensed webusb_serial example (see licenses/).
#define MS_OS_LENGTH 178
#define MS_OS_REQUEST 0x30
static const uint8_t bos[] = {
    TUD_BOS_DESCRIPTOR(TUD_BOS_DESC_LEN + TUD_BOS_MICROSOFT_OS_DESC_LEN, 1),
    TUD_BOS_MS_OS_20_DESCRIPTOR(MS_OS_LENGTH, MS_OS_REQUEST)
};
const uint8_t *tud_descriptor_bos_cb(void) { return bos; }
static const uint8_t ms_os[] = {
    U16_TO_U8S_LE(10), U16_TO_U8S_LE(0), U32_TO_U8S_LE(0x06030000), U16_TO_U8S_LE(MS_OS_LENGTH),
    U16_TO_U8S_LE(8), U16_TO_U8S_LE(1), 0, 0, U16_TO_U8S_LE(MS_OS_LENGTH - 10),
    U16_TO_U8S_LE(8), U16_TO_U8S_LE(2), 4, 0, U16_TO_U8S_LE(MS_OS_LENGTH - 18),
    U16_TO_U8S_LE(20), U16_TO_U8S_LE(3), 'W','I','N','U','S','B',0,0, 0,0,0,0,0,0,0,0,
    U16_TO_U8S_LE(132), U16_TO_U8S_LE(4), U16_TO_U8S_LE(7), U16_TO_U8S_LE(42),
    'D',0,'e',0,'v',0,'i',0,'c',0,'e',0,'I',0,'n',0,'t',0,'e',0,
    'r',0,'f',0,'a',0,'c',0,'e',0,'G',0,'U',0,'I',0,'D',0,'s',0,0,0,
    U16_TO_U8S_LE(80),
    '{',0,'A',0,'5',0,'D',0,'8',0,'0',0,'4',0,'2',0,'E',0,'-',0,
    '4',0,'7',0,'D',0,'3',0,'-',0,'4',0,'B',0,'1',0,'2',0,'-',0,
    '9',0,'6',0,'3',0,'A',0,'-',0,'8',0,'9',0,'E',0,'0',0,'2',0,'1',0,
    '4',0,'F',0,'C',0,'6',0,'B',0,'8',0,'}',0,0,0,0,0
};
TU_VERIFY_STATIC(sizeof(ms_os) == MS_OS_LENGTH, "MS OS descriptor length");
bool bridge_ms_os_request(uint8_t rhport, uint8_t stage, const tusb_control_request_t *request) {
    if (request->bmRequestType != 0xc0 || request->bRequest != MS_OS_REQUEST ||
        request->wIndex != 7 || request->wValue != 0) return false;
    if (stage == CONTROL_STAGE_SETUP) return tud_control_xfer(rhport, request, (void *)ms_os, sizeof(ms_os));
    return true;
}

const uint16_t *tud_descriptor_string_cb(uint8_t index, uint16_t langid) {
    (void)langid;
    static uint16_t descriptor[64];
    static char serial[2 * PICO_UNIQUE_BOARD_ID_SIZE_BYTES + 1];
    const char *strings[] = {NULL, "OpenEPaperLink bench", "Hanshow PIO Readback + UART",
        serial, "SWS readback GPIO0/1", "Tag UART GPIO4/5", "Browser flash readback"};
    if (index == 0) {
        descriptor[0] = (TUSB_DESC_STRING << 8) | 4;
        descriptor[1] = 0x0409;
        return descriptor;
    }
    if (index >= sizeof(strings) / sizeof(strings[0])) return NULL;
    if (index == 3) pico_get_unique_board_id_string(serial, sizeof(serial));
    size_t length = strlen(strings[index]);
    if (length > 63) length = 63;
    for (size_t i = 0; i < length; ++i) descriptor[i + 1] = strings[index][i];
    descriptor[0] = (TUSB_DESC_STRING << 8) | (2 * length + 2);
    return descriptor;
}
