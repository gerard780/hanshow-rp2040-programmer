"""Exercise actual legacy/native status functions against a register-level SPI model."""
import contextlib,importlib.util,io,sys,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT));sys.path.insert(0,str(ROOT/'tools/speed'))
from flash_backend import Flash
spec=importlib.util.spec_from_file_location('legacy',ROOT/'vendor/TLSR825xComFlasher.py')
legacy=importlib.util.module_from_spec(spec);spec.loader.exec_module(legacy)
class Controller:
    def __init__(self):
        self.fifo=False;self.selected=False;self.auto_read=False;self.command=[];self.writes=[]
    def write(self,address,data):
        data=list(data);self.writes.append((address,data))
        if address==0xb3:self.fifo=data==[0x80]
        elif address==0x0d:
            self.selected=not bool(data[0]&1)
            self.auto_read=bool(data[0]&8)
            if data==[0]:self.command=[]
        elif address==0x0c:
            self.command.extend(data if self.fifo else data[:1])
        return True
    def read(self,address,count):
        assert address==0x0c
        if not self.selected or not self.auto_read or len(self.command)<2:return b'\xff'*count
        return bytes([{5:0x2c,0x35:0x38}[self.command[0]]]*count)
class StatusRegression(unittest.TestCase):
    def test_legacy_reports_ff_for_ready_protected_flash(self):
        model=Controller();output=io.StringIO()
        with patch.object(legacy,'rd_sws_wr_addr_usbcom',side_effect=lambda p,a,d:model.write(a,d)),patch.object(legacy,'sws_read_data',side_effect=lambda p,a,n=1:list(model.read(a,n))),contextlib.redirect_stdout(output):
            self.assertFalse(legacy.FlashReady(None,3))
        self.assertIn('Timeout! Flash status 0xff!',output.getvalue())
        self.assertFalse(any(a==0x0d and d==[0x0a] for a,d in model.writes))
        self.assertTrue(all(d==[5] for a,d in model.writes if a==0x0c))
    def test_correct_backend_reads_both_status_bytes_and_ready(self):
        model=Controller();flash=Flash(None,None,None)
        with patch.object(flash,'checked',side_effect=model.write),patch('flash_backend.bench.block_read',side_effect=lambda r,p,d,a,n:model.read(a,n)):
            self.assertEqual(flash.status(),0x382c)
            flash.ready()
        commands=[d for a,d in model.writes if a==0x0c]
        self.assertEqual(commands,[[5,0],[0x35,0],[5,0]])
        self.assertFalse(model.fifo);self.assertFalse(model.selected)
        self.assertTrue(all(d[0] in (5,0x35) for d in commands))
if __name__=='__main__':unittest.main(verbosity=2)
