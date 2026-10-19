#!/usr/bin/env python3
"""Exec the sidecar without a controlling terminal, keeping its PID/group."""
import errno
import fcntl
import os
import sys
import termios

try:
    try:
        tty_fd = os.open('/dev/tty', os.O_RDWR | os.O_NOCTTY)
    except OSError as error:
        if error.errno not in (errno.ENXIO, errno.ENODEV, errno.ENOTTY, errno.ENOENT):
            raise
    else:
        try:
            # Detaching a session leader may signal the whole foreground group.
            # The background child must detach only itself, never the pane.
            if os.getsid(0) == os.getpid():
                raise RuntimeError('refusing to detach a terminal session leader')
            fcntl.ioctl(tty_fd, termios.TIOCNOTTY)
        finally:
            os.close(tty_fd)
    os.execv(sys.argv[1], sys.argv[1:])
except (OSError, RuntimeError, IndexError):
    # Executable arguments or OS diagnostics may contain private config values.
    print('[codex-sidecar] isolated exec failed', file=sys.stderr)
    sys.exit(127)
