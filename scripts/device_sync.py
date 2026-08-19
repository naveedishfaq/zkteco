#!/usr/bin/env python3
"""
Talks directly to a ZKTeco device over its native protocol (pyzk).
Prints JSON on stdout. Never touches ZKBioTime or any other software.

Usage:
  device_sync.py test  --ip IP --port PORT --password PASS
  device_sync.py time  --ip IP --port PORT --password PASS
  device_sync.py sync  --ip IP --port PORT --password PASS
"""

import argparse
import json
import sys
from datetime import datetime

from zk import ZK


def default_serializer(obj):
    if isinstance(obj, datetime):
        return obj.isoformat()
    return str(obj)


def connect(ip, port, password):
    zk = ZK(ip, port=port, timeout=10, password=password, force_udp=False, ommit_ping=True)
    return zk.connect()


def cmd_test(args):
    conn = connect(args.ip, args.port, args.password)
    try:
        info = {
            'device_name': conn.get_device_name(),
            'firmware_version': conn.get_firmware_version(),
            'serial_number': conn.get_serialnumber(),
            'platform': conn.get_platform(),
            'device_time': conn.get_time(),
            'user_count': len(conn.get_users()),
        }
        print(json.dumps({'success': True, **info}, default=default_serializer))
    finally:
        conn.disconnect()


def cmd_time(args):
    conn = connect(args.ip, args.port, args.password)
    try:
        print(json.dumps({'success': True, 'device_time': conn.get_time()}, default=default_serializer))
    finally:
        conn.disconnect()


def cmd_sync(args):
    conn = connect(args.ip, args.port, args.password)
    try:
        conn.disable_device()

        info = {
            'device_name': conn.get_device_name(),
            'firmware_version': conn.get_firmware_version(),
            'serial_number': conn.get_serialnumber(),
            'platform': conn.get_platform(),
            'device_time': conn.get_time(),
        }

        users = [{
            'uid': u.uid, 'user_id': u.user_id, 'name': u.name,
            'privilege': u.privilege, 'card': u.card,
        } for u in conn.get_users()]

        attendance = [{
            'user_id': a.user_id, 'timestamp': a.timestamp,
            'status': a.status, 'punch': a.punch,
        } for a in conn.get_attendance()]

        conn.enable_device()

        print(json.dumps({
            'success': True, 'device_info': info, 'users': users, 'attendance': attendance,
        }, default=default_serializer))
    finally:
        conn.disconnect()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['test', 'time', 'sync'])
    parser.add_argument('--ip', required=True)
    parser.add_argument('--port', type=int, default=4370)
    parser.add_argument('--password', type=int, default=0)
    args = parser.parse_args()

    handlers = {'test': cmd_test, 'time': cmd_time, 'sync': cmd_sync}

    try:
        handlers[args.command](args)
    except Exception as e:
        print(json.dumps({'success': False, 'error': str(e)}))
        sys.exit(1)


if __name__ == '__main__':
    main()
