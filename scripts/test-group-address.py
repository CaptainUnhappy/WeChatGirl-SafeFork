import importlib.util
import pathlib
import hashlib
import sqlite3
from types import SimpleNamespace
from unittest.mock import patch
import unittest

spec = importlib.util.spec_from_file_location('reader_api', pathlib.Path(__file__).with_name('reader-api.py'))
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)


class IncomingAddressTest(unittest.TestCase):
    def test_recipient_data_is_explicit_and_bounded(self):
        values = reader.mention_recipients(b'<msgsource><atuserlist> wxid_fish,wxid_other,wxid_fish </atuserlist></msgsource>')
        self.assertEqual(values, ['wxid_fish', 'wxid_other'])
        self.assertIsNone(reader.mention_recipients('<msg><atuserlist>someone</atuserlist></msg>'))
        self.assertIsNone(reader.mention_recipients('<msgsource><atuserlist>display name</atuserlist></msgsource>'))
        self.assertIsNone(reader.mention_recipients('<msgsource><atuserlist>' + 'a' * 8192 + '</atuserlist></msgsource>'))
        msg = dict(senderUsername='wxid_sender', localType=1, fullText='@小鱼\u2005在吗', createTime=1, mentionWxids=values)
        self.assertEqual(reader.push_payload('demo@chatroom', msg, {}, 'wxid_fish', 123)['mentionWxids'], values)

    def test_reader_uses_the_source_column_and_keeps_old_schema_readable(self):
        talker = 'demo@chatroom'
        table = 'Msg_' + hashlib.md5(talker.encode()).hexdigest()
        text = '@小鱼\u2005这是给同名群友的'
        source = '<msgsource><atuserlist>wxid_other</atuserlist></msgsource>'
        for column in ('message_source', 'source', None):
            with self.subTest(column=column):
                connection = sqlite3.connect(':memory:')
                connection.execute(f'CREATE TABLE "{table}" (local_id, create_time, server_id, message_content' +
                                   (', ' + column if column else '') + ')')
                values = (1, 2, 3, text) + ((source,) if column else ())
                connection.execute(f'INSERT INTO "{table}" VALUES (' + ','.join('?' * len(values)) + ')', values)
                fake = SimpleNamespace(selected_talkers=lambda: [talker], open_messages=lambda: [connection],
                                       names={}, own_wxid='wxid_fish')
                upstream = SimpleNamespace(get_messages=lambda *args, **kwargs: {'messages': [
                    dict(localId=1, createTime=2, serverId=3, localType=1, senderUsername='wxid_sender')]},
                    msg_tables=lambda conn: [table], _decode_content=lambda value: value,
                    _strip_group_speaker=lambda value, _names: value)
                with patch.object(reader, 'nt', upstream):
                    [row] = reader.Reader.messages(fake, talker)
                self.assertEqual(row['fullText'], text)
                self.assertEqual(row.get('mentionWxids'), ['wxid_other'] if column else None)


if __name__ == '__main__':
    unittest.main()
