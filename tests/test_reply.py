"""Exercise the actual PIO source against synthetic pulse timings.

This instruction model checks byte decoding and publication after the end cell;
it does not model electrical behavior, GPIO synchronizers or prove hardware IO.
"""
import re
import unittest
from pathlib import Path


def program():
    source = (Path(__file__).parents[1] / "src/serial.pio").read_text()
    source = source.split(".program swire_reply\n", 1)[1].split(".program", 1)[0]
    instructions, labels = [], {}
    for line in source.splitlines():
        line = line.split(";", 1)[0].strip()
        if not line:
            continue
        if line.endswith(":"):
            labels[line[:-1]] = len(instructions)
        else:
            instructions.append(line)
    return instructions, labels


def decode(byte, unit, shape, omit_end=False, stuck_end=False):
    code, labels = program()
    short, long, cell = (2 * unit, 5 * unit, 7 * unit) if shape == "telink" else (2 * unit, 8 * unit, 10 * unit)
    # Master request, reply data, then its short-low end cell. Include idle
    # before the first pulse so WAIT 0/WAIT 1 must actually synchronize.
    pulses = [(unit, unit + short)]
    start = unit + cell
    for bit in range(7, -1, -1):
        pulses.append((start, start + (long if byte & (1 << bit) else short)))
        start += cell
    if not omit_end:
        pulses.append((start, start + (1000000 if stuck_end else short)))
    end = start + cell
    pc = tick = x = y = shift = 0
    limit = end + 20 * cell
    while tick < limit:
        pin = not any(a <= tick < b for a, b in pulses)
        instruction = code[pc]
        match = re.search(r"\[(\d+)\]", instruction)
        delay = int(match[1]) if match else 0
        op = re.sub(r"\s*\[\d+\]", "", instruction).replace(",", "").split()
        next_pc = pc + 1
        if op[0] == "wait":
            if pin != bool(int(op[1])):
                next_pc = pc
        elif op[0] == "set":
            if op[1] == "x": x = int(op[2])
            else: y = int(op[2])
        elif op[0] == "mov":
            x = 0xffffffff if op[2] == "!null" else x ^ 0xffffffff
        elif op[0] == "jmp":
            condition = True
            if op[1] == "pin": condition = pin
            elif op[1] == "x--":
                condition = x != 0
                x = (x - 1) & 0xffffffff
            elif op[1] == "y--":
                condition = y != 0
                y = (y - 1) & 0xffffffff
            if condition: next_pc = labels[op[-1]]
        elif op[0] == "in":
            shift = ((shift << 1) | (x & 1 if op[1] == "x" else 0)) & 0xffffffff
        elif op[0] == "push":
            return shift & 255, tick, end
        else:
            raise AssertionError(instruction)
        pc, tick = next_pc, tick + 1 + delay
    return None


class ReplyTests(unittest.TestCase):
    def test_every_byte_and_rate_finishes_end_cell(self):
        for shape in ("telink", "uart"):
            for unit in (12, 48, 192):
                for byte in range(256):
                    with self.subTest(shape=shape, unit=unit, byte=byte):
                        result = decode(byte, unit, shape)
                        self.assertIsNotNone(result)
                        actual, pushed, ended = result
                        self.assertEqual(actual, byte)
                        self.assertGreaterEqual(pushed, ended)

    def test_missing_or_stuck_end_does_not_publish(self):
        for byte in (0, 255, 0x55, 0xaa):
            self.assertIsNone(decode(byte, 48, "telink", omit_end=True))
            self.assertIsNone(decode(byte, 48, "telink", stuck_end=True))

    def test_program_and_tracer_fit_pio1(self):
        self.assertLessEqual(len(program()[0]) + 1, 32)


if __name__ == "__main__":
    unittest.main()
