#include <string.h>
#include "pico/unique_id.h"
#include "tusb.h"

// TinyUSB's example VID/PID, for a private prototype, not a registered product.
static const tusb_desc_device_t device = {
    .bLength = sizeof(tusb_desc_device_t), .bDescriptorType = TUSB_DESC_DEVICE,
    .bcdUSB = 0x0200, .bDeviceClass = TUSB_CLASS_MISC,
    .bDeviceSubClass = MISC_SUBCLASS_COMMON, .bDeviceProtocol = MISC_PROTOCOL_IAD,
    .bMaxPacketSize0 = CFG_TUD_ENDPOINT0_SIZE,
    .idVendor = 0xcafe, .idProduct = 0x4012, .bcdDevice = 0x0103,
    .iManufacturer = 1, .iProduct = 2, .iSerialNumber = 3, .bNumConfigurations = 1
};
const uint8_t *tud_descriptor_device_cb(void) { return (const uint8_t *)&device; }

static const uint8_t configuration[] = {
    TUD_CONFIG_DESCRIPTOR(1, 4, 0, TUD_CONFIG_DESC_LEN + 2 * TUD_CDC_DESC_LEN, 0, 250),
    TUD_CDC_DESCRIPTOR(0, 4, 0x81, 16, 0x02, 0x82, 64),
    TUD_CDC_DESCRIPTOR(2, 5, 0x83, 16, 0x04, 0x84, 64)
};
const uint8_t *tud_descriptor_configuration_cb(uint8_t index) {
    (void)index;
    return configuration;
}

const uint16_t *tud_descriptor_string_cb(uint8_t index, uint16_t langid) {
    (void)langid;
    static uint16_t descriptor[64];
    static char serial[2 * PICO_UNIQUE_BOARD_ID_SIZE_BYTES + 1];
    const char *strings[] = {NULL, "OpenEPaperLink bench", "Hanshow PIO Readback + UART",
        serial, "SWS readback GPIO0/1", "Tag UART GPIO4/5"};
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
