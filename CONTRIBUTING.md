# Contributing to nav-pi

Bug reports, test results from real hardware and pull requests are welcome.

## Reporting a bug or a test result

Open an issue on GitHub. Please include:

- the board (Pi 4 or Pi 5, RAM), the screen, the storage (SD card or USB SSD) and the GPS receiver, if any
- the edition and app version (shown in *Settings > System*) and the region you built
- what you did, what you expected and what happened
- relevant logs, for example `/var/log/nav-pi-firstboot.log` or `journalctl -u nav-pi -b` on the Pi
  ([docs/OPERATING.md](docs/OPERATING.md#troubleshooting-on-the-device) lists which log belongs to what)
- for a security problem whose details should not be public, see [docs/SECURITY.md](docs/SECURITY.md#reporting-a-security-problem)

Results from untested situations are particularly useful: a real drive with a GPS receiver, other boards, HDMI
screens, phones over Bluetooth. [docs/STATUS.md](docs/STATUS.md) lists what is tested and what is not.

## Before you open a pull request

- Run the unit tests: `python3 -m unittest discover tests` and the Node tests (see [docs/TESTING.md](docs/TESTING.md)).
  How to run the app on your PC: [docs/DEVELOPING.md](docs/DEVELOPING.md).
- For a UI change, run `bash tools/run-ui-tests.sh layout-guard`, plus the tests of the part you changed.
- Say what you tested and how: in a browser, on which Pi and screen, with or without a real GPS. Also say what you
  did not test. [docs/STATUS.md](docs/STATUS.md) shows the level of detail that helps.
- Keep the project's rules:
  - offline by default: nothing connects to the internet unless the user starts it
  - nav-pi's services on the Pi listen on `127.0.0.1` only (no new network service; see [docs/SECURITY.md](docs/SECURITY.md))
  - no new Python packages on the Pi: navd uses the Python standard library only
  - every file of the offline bundle is checksum-verified against an official or pinned checksum, and every copy
    of region data is checked against its `BUILD-INFO`
  - UI changes follow [docs/UI-RULES.md](docs/UI-RULES.md)

## Licence of contributions

nav-pi is licensed under the GNU GPL version 3 ([LICENSE](LICENSE)). The copyright holder (MohamadKoteich) also
offers nav-pi under other licence terms. So that this stays possible, contributions are accepted on these terms:

1. You license your contribution to everyone under the **GPL version 3**, like the rest of nav-pi.
2. You also grant the copyright holder, **MohamadKoteich**, a perpetual, worldwide, non-exclusive, royalty-free,
   irrevocable licence to use, modify, sublicense and distribute your contribution under **any other licence
   terms**, including in closed-source products.
3. You confirm that the contribution is your own work, or that you have the right to submit it on these terms.
   You keep the copyright of your contribution.

By opening a pull request, you agree to these terms. Add this line to your commit messages:

```
Signed-off-by: Your Name <your@email>
```

(`git commit -s` adds it.)
