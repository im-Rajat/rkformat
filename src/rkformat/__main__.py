"""Allow `python -m rkformat` as an alias for the `rk` command."""

from .cli import main

if __name__ == "__main__":
    raise SystemExit(main())
