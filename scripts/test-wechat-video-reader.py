"""Synthetic WeChat index rows and media files."""
import base64
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from wechat_video import indexed_video_candidates, locate_indexed_video, locate_local_video, packed_video_tokens, video_duration, video_message_pattern, video_open_selector


class VideoLookupTests(unittest.TestCase):
    def test_open_target_can_be_selected_by_duration_among_group_videos(self):
        target = {'localType': 43, 'serverId': '123', 'localId': 4, 'createTime': 100,
                  'videoDuration': video_duration('<msg><videomsg playlength="18"/></msg>')}
        other = {**target, 'localType': 62, 'serverId': '124', 'localId': 5, 'videoDuration': 36}
        identity = ('123', 4, 100)
        self.assertEqual(video_open_selector([other, target], identity)['displaySeconds'], [17, 18, 19])
        self.assertTrue(video_open_selector([target], identity)['onlyVideo'])
        close = [{**other, 'videoDuration': 16}, target, {**other, 'localId': 6, 'videoDuration': 20}]
        self.assertEqual(video_open_selector(close, identity)['displaySeconds'], [18])
        marker = {'localType': 1, 'fullText': '  preceding message  '}
        anchored = video_open_selector([target, {**other, 'videoDuration': 18}, marker], identity)
        self.assertEqual(anchored['displaySeconds'], [])
        self.assertEqual(anchored['before'], [video_message_pattern(marker), 'v'])
        for rows in ([{**other, 'videoDuration': 18}, target], [{**other, 'videoDuration': 0}, target], [other], [{**target, 'isSend': True}]):
            with self.subTest(rows=rows), self.assertRaisesRegex(LookupError, 'VIDEO_TARGET_NOT_UNIQUE'):
                video_open_selector(rows, identity)

    def test_index_maps_message_hash_to_different_filename(self):
        message_md5, filename_hash = '1' * 32, 'a' * 32
        with tempfile.TemporaryDirectory() as folder, sqlite3.connect(':memory:') as db:
            account = Path(folder).resolve()
            cache = account / 'msg/video/2026-11'
            cache.mkdir(parents=True)
            media = cache / (filename_hash + '.mp4')
            media.write_bytes(b'\x00\x00\x00\x18ftypmp42fixture')
            db.executescript('CREATE TABLE dir2id(username); CREATE TABLE video_hardlink_info_v4(md5,file_name,dir1,modify_time);')
            db.execute('INSERT INTO dir2id VALUES (?)', ('2026-11',))
            db.executemany('INSERT INTO video_hardlink_info_v4 VALUES (?,?,1,?)',
                           [(message_md5, '../' + media.name, 2), (message_md5, media.name, 1)])
            with self.assertRaises(FileNotFoundError):
                locate_local_video(account, (), (message_md5,))
            candidates = list(indexed_video_candidates(db.cursor(), (message_md5,)))
            self.assertEqual(candidates, [('2026-11', media.name)])
            self.assertEqual(locate_indexed_video(account, candidates), media)
            self.assertEqual(list(indexed_video_candidates(db.cursor(), ('b' * 32,))), [])

    def test_packed_filename_binary_hex_and_base64(self):
        token = 'a' * 32
        packed = b'\x12\x02\x00' + token.encode() + b'_raw.mp4'
        for value in (packed, memoryview(packed), packed.hex(), base64.b64encode(packed).decode()):
            with self.subTest(format=type(value)):
                self.assertEqual(packed_video_tokens(value), (token,))


if __name__ == '__main__':
    unittest.main()
