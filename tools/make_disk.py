#!/usr/bin/env python3
"""Compose a self-contained nav-pi disk (no root): partition table + boot + OS + a data partition.

  python3 tools/make_disk.py <boot-root.img> <stage-dir> <out-dir> [--root-gib 64]

boot-root.img = scripts/01-build-image.sh output (MBR, p1 FAT boot, p2 official Raspberry Pi OS root).
stage-dir     = the tree that becomes /srv/navdata on the Pi (region data + kit), owned by uid 1000.
Writes to out-dir:
  head.img      MBR (p1 boot, p2 root grown to --root-gib in the table, p3 data) + p1 + p2 filesystem
  data.img      ext4 LABEL=navdata built from stage-dir (mke2fs -d), placed at p3
  manifest.json what to write where + sha256 of each piece (scripts/41-write-disk.sh writes and reads back)
The Pi grows p2's filesystem and p3 (to the end of the disk) on first boot (pi/firstboot.sh).
"""
import argparse, hashlib, json, os, struct, subprocess, sys

SECTOR = 512
ALIGN = 8192  # 4 MiB (the writer uses 4 MiB blocks)


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(8 << 20), b""):
            h.update(b)
    return h.hexdigest()


def du_bytes(path):
    total = 0
    seen = set()
    for d, _, files in os.walk(path):
        for n in files:
            st = os.lstat(os.path.join(d, n))
            if (st.st_dev, st.st_ino) in seen:
                continue
            seen.add((st.st_dev, st.st_ino))
            total += st.st_size
    return total


def entry(ptype, start, count):
    # CHS fields set to the "use LBA" maximum, like modern partitioners
    return bytes([0x00, 0xFE, 0xFF, 0xFF, ptype, 0xFE, 0xFF, 0xFF]) + struct.pack("<II", start, count)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image"); ap.add_argument("stage"); ap.add_argument("out")
    ap.add_argument("--root-gib", type=int, default=64)
    ap.add_argument("--headroom-gib", type=int, default=4)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    with open(a.image, "rb") as f:
        mbr = bytearray(f.read(SECTOR))
    if mbr[510:512] != b"\x55\xaa":
        sys.exit("not an MBR image")
    p = [struct.unpack("<II", mbr[446 + 16 * i + 8:446 + 16 * i + 16]) for i in range(4)]
    (b_start, b_count), (r_start, r_count) = p[0], p[1]
    if mbr[446 + 4] not in (0x0B, 0x0C) or mbr[446 + 16 + 4] != 0x83 or p[2] != (0, 0):
        sys.exit("unexpected partition table in %s: %s" % (a.image, p))
    img_size = os.path.getsize(a.image)
    if img_size != (r_start + r_count) * SECTOR:
        sys.exit("image does not end with the root partition")

    root_count = max(r_count, a.root_gib * (1 << 30) // SECTOR)
    d_start = -(-(r_start + root_count) // ALIGN) * ALIGN
    data = du_bytes(a.stage)
    d_bytes = (int(data * 1.04) + a.headroom_gib * (1 << 30)) // (1 << 20) * (1 << 20)
    d_count = d_bytes // SECTOR
    if d_start + d_count > 0xFFFFFFFF:
        sys.exit("disk too big for MBR")

    mbr[446 + 16:446 + 32] = entry(0x83, r_start, root_count)
    mbr[446 + 32:446 + 48] = entry(0x83, d_start, d_count)
    head = os.path.join(a.out, "head.img")
    with open(a.image, "rb") as fi, open(head, "wb") as fo:
        fo.write(mbr); fi.seek(SECTOR)
        for b in iter(lambda: fi.read(8 << 20), b""):
            fo.write(b)

    dimg = os.path.join(a.out, "data.img")
    if os.path.exists(dimg):
        os.remove(dimg)
    print("data partition: %.1f GiB of files -> %.1f GiB filesystem" % (data / 2**30, d_bytes / 2**30), flush=True)
    subprocess.run(["/usr/sbin/mke2fs", "-q", "-t", "ext4", "-b", "4096", "-L", "navdata", "-m", "0", "-d", a.stage,
                    "-E", "root_owner=1000:1000", dimg, str(d_bytes // 4096)], check=True)   # -b: without it a plain size means KiB
    r = subprocess.run(["/usr/sbin/e2fsck", "-fn", dimg], capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit("e2fsck on data.img failed:\n" + r.stdout[-2000:] + r.stderr[-2000:])

    man = {
        "pieces": [
            {"file": "head.img", "offset": 0, "size": os.path.getsize(head), "sha256": sha256(head)},
            {"file": "data.img", "offset": d_start * SECTOR, "size": d_bytes, "sha256": sha256(dimg)},
        ],
        "min_disk_bytes": d_start * SECTOR + d_bytes,
        "partitions": {"boot": [b_start, b_count], "root": [r_start, root_count], "data": [d_start, d_count]},
    }
    with open(os.path.join(a.out, "manifest.json"), "w") as f:
        json.dump(man, f, indent=1)
    print(json.dumps(man, indent=1))


if __name__ == "__main__":
    main()
