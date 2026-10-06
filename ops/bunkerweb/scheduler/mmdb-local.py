#!/usr/bin/env python3
# Morphit: BunkerWeb's GeoIP databases, from the copies inside its own image.
#
# BunkerWeb 1.5.10's own mmdb-country and mmdb-asn jobs ask db-ip.com every day
# and download a new database from it. No setting turns them off, so Morphit's
# scheduler runs this job in their place (ops/bunkerweb/scheduler/jobs-plugin.json,
# mounted over the image's list of internal jobs): it puts the databases the
# image ships (/var/tmp/bunkerweb/*.mmdb) where BunkerWeb looks them up, and
# fetches nothing. Nothing on a Morphit instance uses them: there are no
# country or ASN rules (no instance turns visitors away by where they are).

from os import getenv, sep
from os.path import join
from pathlib import Path
from sys import exit as sys_exit, path as sys_path
from traceback import format_exc

for deps_path in [join(sep, "usr", "share", "bunkerweb", *paths) for paths in (("deps", "python"), ("utils",), ("db",))]:
    if deps_path not in sys_path:
        sys_path.append(deps_path)

from maxminddb import open_database  # type: ignore

from common_utils import file_hash  # type: ignore
from jobs import Job  # type: ignore
from logger import setup_logger  # type: ignore

LOGGER = setup_logger("JOBS.mmdb-local", getenv("LOG_LEVEL", "INFO"))
status = 0

try:
    JOB = Job(LOGGER)
    for name in ("country.mmdb", "asn.mmdb"):
        image_copy = Path(sep, "var", "tmp", "bunkerweb", name)
        cached = JOB.job_path.joinpath(name)
        if cached.is_file():
            # One is in place already (an earlier copy, or one BunkerWeb's own
            # job downloaded before Morphit replaced it): keep it if it opens.
            try:
                with open_database(cached.as_posix()):
                    continue
            except BaseException:
                LOGGER.warning(f"The {name} in place does not open; putting the image's copy there.")
        if not image_copy.is_file():
            LOGGER.warning(f"No {name} in this BunkerWeb image; country and ASN rules have nothing to look up.")
            continue
        new_hash = file_hash(image_copy)
        with open_database(image_copy.as_posix()):
            pass
        ok, err = JOB.cache_file(name, image_copy, checksum=new_hash, delete_file=False)
        if not ok:
            LOGGER.error(f"Could not put {name} in place: {err}")
            status = 2
            continue
        LOGGER.info(f"{name} put in place from the BunkerWeb image (nothing downloaded).")
        status = max(status, 1)
except SystemExit as e:
    status = e.code
except BaseException:
    status = 2
    LOGGER.error(f"Exception while running mmdb-local.py :\n{format_exc()}")

sys_exit(status)
