#!/usr/bin/env python3
"""Copy folders out of an ext4 filesystem image without root (debugfs, read-only).

    python3 tools/ext4_extract.py <rootfs.ext4> <out-dir> /etc/apt /usr/share/keyrings ...

`debugfs rdump` stops at the first file it cannot chown as a normal user, so this walks the tree with
`ls -p` and dumps each regular file with `dump` (no ownership change). Symbolic links are resolved
inside the image (up to 8 hops) and stored as a copy of their target file. Writes <out-dir>/<path>."""
import os
import posixpath
import subprocess
import sys


def dfs(img, cmd):
    r = subprocess.run(["debugfs", "-R", cmd, img], capture_output=True, text=True)
    return r.stdout


def entries(img, d):
    for line in dfs(img, "ls -p %s" % d).splitlines():   # /inode/mode/uid/gid/name/size/
        p = line.strip().split("/")
        if len(p) >= 7 and p[5] not in (".", ".."):
            yield p[5], int(p[2], 8)


def link_target(img, path):
    for line in dfs(img, "stat %s" % path).splitlines():
        if "Fast link dest:" in line:
            return line.split("Fast link dest:", 1)[1].strip().strip('"')
    return None


def dump(img, path, out):
    os.makedirs(os.path.dirname(out), exist_ok=True)
    subprocess.run(["debugfs", "-R", "dump %s %s" % (path, out), img], capture_output=True, check=True)


def walk(img, d, outroot, n):
    for name, mode in entries(img, d):
        path = posixpath.join(d, name)
        kind = mode & 0o170000
        if kind == 0o040000:
            os.makedirs(outroot + path, exist_ok=True)
            n = walk(img, path, outroot, n)
        elif kind == 0o100000:
            dump(img, path, outroot + path); n += 1
        elif kind == 0o120000:
            cur = path
            for _ in range(8):   # follow the chain inside the image
                t = link_target(img, cur)
                if t is None:
                    break
                cur = posixpath.normpath(posixpath.join(posixpath.dirname(cur), t))
            if cur != path and "Type: regular" in dfs(img, "stat %s" % cur):
                dump(img, cur, outroot + path); n += 1
    return n


def main():
    if len(sys.argv) < 4:
        sys.exit(__doc__)
    img, out = sys.argv[1], os.path.abspath(sys.argv[2])
    for d in sys.argv[3:]:
        os.makedirs(out + d, exist_ok=True)
        print("%s: %d files" % (d, walk(img, d.rstrip("/") or "/", out, 0)))


if __name__ == "__main__":
    main()
