"""Check v1.5 reconnects against its real idle-only width setter contract."""
import struct,sys,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).parents[1]))
import benchmark_readback as bench
class Device:
    def __init__(self,width=3,active=True):self.width=width;self.active=active;self.calls=[]
    def ctrl_transfer(self,kind,request,value,index,data,**kwargs):
        self.calls.append((kind,request,value,index))
        if kind==0xc0:return struct.pack('<I',self.width)
        if self.active:raise RuntimeError('Firmware stalls SET while SWS active')
        self.width=value;return 0
class WidthTests(unittest.TestCase):
    def test_previous_session_with_three_byte_headers_needs_no_set(self):
        dev=Device()
        with patch.object(bench,'bridge_status',return_value={'version':'1.5'}):bench.select_825x_width(dev)
        self.assertEqual(dev.calls,[(0xc0,0x21,0,0)])
    def test_idle_wrong_width_is_changed_and_verified(self):
        dev=Device(2,False)
        with patch.object(bench,'bridge_status',return_value={'version':'1.5'}):bench.select_825x_width(dev)
        self.assertEqual(dev.width,3);self.assertEqual(len(dev.calls),3)
    def test_invalid_reply_is_rejected_without_set(self):
        dev=Device(4)
        with patch.object(bench,'bridge_status',return_value={'version':'1.5'}):
            with self.assertRaisesRegex(RuntimeError,'Invalid'):bench.select_825x_width(dev)
        self.assertEqual(len(dev.calls),1)
    def test_older_bridge_uses_fixed_width(self):
        dev=Device()
        with patch.object(bench,'bridge_status',return_value={'version':'1.4'}):bench.select_825x_width(dev)
        self.assertEqual(dev.calls,[])
if __name__=='__main__':unittest.main()
