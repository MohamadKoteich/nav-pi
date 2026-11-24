#!/usr/bin/env python3
"""Put files into the FAT boot partition of a Raspberry Pi OS image, without root.

    fat_inject.py IMAGE DEST=SRC [DEST=SRC ...]

DEST is a path inside the boot partition (e.g. /user-data, /nav-pi/firstboot.sh).
Existing files are removed and recreated (overwriting in place trips a pyfatfs bug).
Afterwards every new file is read back, and every other file is compared with the
original partition: the script fails unless only the named files changed.
"""
import os
import shutil
import struct
import sys
import tempfile
import warnings

warnings.filterwarnings("ignore")
from pyfatfs.PyFatFS import PyFatFS  # noqa: E402

SECTOR = 512


def boot_partition(image):
    with open(image, "rb") as f:
        mbr = f.read(SECTOR)
    if mbr[510:512] != b"\x55\xaa":
        sys.exit("not an MBR disk image: " + image)
    entry = mbr[446:462]
    ptype = entry[4]
    start, count = struct.unpack("<II", entry[8:16])
    if ptype not in (0x0B, 0x0C, 0x0E):
        sys.exit("partition 1 is not FAT (type 0x%02x)" % ptype)
    return start * SECTOR, count * SECTOR


def copy_range(src, dst, offset, length, seek=False):
    with open(src, "rb") as fi, open(dst, "r+b" if seek else "wb") as fo:
        fi.seek(0 if seek else offset)
        if seek:
            fo.seek(offset)
        left = length
        while left:
            chunk = fi.read(min(left, 4 << 20))
            if not chunk:
                sys.exit("short read")
            fo.write(chunk)
            left -= len(chunk)


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    image = sys.argv[1]
    files = dict(a.split("=", 1) for a in sys.argv[2:])
    offset, length = boot_partition(image)
    tmp = tempfile.mkdtemp()
    orig, work = os.path.join(tmp, "orig.fat"), os.path.join(tmp, "work.fat")
    try:
        copy_range(image, orig, offset, length)
        shutil.copyfile(orig, work)
        fs = PyFatFS(work)
        for dst, src in files.items():
            parent = os.path.dirname(dst)
            if parent not in ("", "/") and not fs.exists(parent):
                fs.makedirs(parent)
            if fs.exists(dst):
                fs.remove(dst)
            with open(src, "rb") as fi, fs.openbin(dst, "w") as fo:
                fo.write(fi.read())
        fs.close()
        a, b = PyFatFS(orig), PyFatFS(work)
        for dst, src in files.items():
            if b.readbytes(dst) != open(src, "rb").read():
                sys.exit("read-back mismatch: " + dst)
        others = [p for p in a.walk.files("/") if p not in files]
        changed = [p for p in others if a.readbytes(p) != b.readbytes(p)]
        a.close(), b.close()
        if changed:
            sys.exit("unexpected changes: %s" % changed[:5])
        copy_range(work, image, offset, length, seek=True)
        print("boot partition: %d files written and read back, %d original files unchanged"
              % (len(files), len(others)))
    finally:
        shutil.rmtree(tmp)


if __name__ == "__main__":
    main()
