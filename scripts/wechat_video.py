"""Resolve the local MP4 belonging to a WeChat type-43 database row."""
import hashlib
import base64
import binascii
import re
from collections import Counter

VIDEO_TYPE = 43
VIDEO_TYPES = {43, 62}
MONTH = re.compile(r'\d{4}-(?:0[1-9]|1[0-2])')
TOKEN = re.compile(r'(?<![a-fA-F0-9])[a-fA-F0-9]{32}(?![a-fA-F0-9])')
PACKED_COLUMNS = ('packed_info_data', 'packed_info_blob', 'packed_info', 'BytesExtra', 'bytes_extra', 'WCDB_CT_packed_info')


def video_duration(text):
    tag = re.search(r'<videomsg\b[^<>]{1,8192}>', text or '', re.I)
    match = re.search(r"""\splaylength\s*=\s*["']([0-9]{1,5})["']""", tag.group(), re.I) if tag else None
    return int(match.group(1)) if match else 0


def video_message_pattern(row):
    if row.get('localType') in VIDEO_TYPES:
        return 'v'
    if row.get('localType') != 1:
        return None
    text = re.sub(r'\s+', ' ', row.get('fullText') or row.get('content') or '').strip()
    if not text or len(text) > 160:
        return None
    return 't:' + hashlib.sha256(text.encode('utf-8')).hexdigest()


def video_open_selector(rows, identity):
    videos = [row for row in rows if row.get('localType') in VIDEO_TYPES]
    target = next((row for row in videos if
                   (row.get('serverId'), row.get('localId'), row.get('createTime')) == tuple(identity)), None)
    if not identity[0] or not target or target.get('isSend'):
        raise LookupError('VIDEO_TARGET_NOT_UNIQUE')
    seconds = target.get('videoDuration', 0)
    others = [row.get('videoDuration', 0) for row in videos if row is not target]
    display_seconds = [value for value in range(max(1, seconds - 1), seconds + 2)
                       if seconds and all(other and abs(other - value) > 1 for other in others)]
    chronological = list(reversed(rows))
    position = next(index for index, row in enumerate(chronological) if row is target)
    patterns = [video_message_pattern(row) for row in chronological]
    counts = Counter(patterns)

    def anchor(step):
        chain = []
        for index in range(position + step, position + step * 9, step):
            if not 0 <= index < len(patterns) or patterns[index] is None:
                break
            pattern = patterns[index]
            chain.append(pattern)
            if pattern.startswith('t:') and counts[pattern] == 1:
                return chain if step > 0 else list(reversed(chain))
        return []

    before, after = anchor(-1), anchor(1)
    if others and not display_seconds and not before and not after:
        raise LookupError('VIDEO_TARGET_NOT_UNIQUE')
    return {'seconds': seconds, 'displaySeconds': display_seconds, 'onlyVideo': not others,
            'before': before, 'after': after}


def packed_video_tokens(packed):
    if isinstance(packed, (bytes, bytearray, memoryview)):
        packed = bytes(packed[:8192]).decode('ascii', 'replace')
    if not isinstance(packed, str):
        return ()
    text = packed[:8192]
    direct = TOKEN.findall(text)
    if direct:
        return tuple(dict.fromkeys(token.lower() for token in direct))
    compact = ''.join(text.split())
    if len(compact) < 44:
        return ()
    try:
        raw = bytes.fromhex(compact) if re.fullmatch(r'(?:[a-fA-F0-9]{2})+', compact) else base64.b64decode(compact, validate=True)
    except (ValueError, binascii.Error):
        return ()
    return tuple(dict.fromkeys(token.lower() for token in TOKEN.findall(raw.decode('ascii', 'replace'))))


def video_identifiers(text, packed=None):
    tag = re.search(r'<videomsg\b[^<>]{1,8192}>', text or '', re.I)
    hashes = re.findall(r"""\s(?:md5|rawmd5|newmd5)\s*=\s*["']([a-fA-F0-9]{32})["']""", tag.group(), re.I) if tag else []
    return packed_video_tokens(packed), tuple(dict.fromkeys(value.lower() for value in hashes))


def indexed_video_candidates(cursor, tokens):
    for token in tokens[:64]:
        if not TOKEN.fullmatch(token):
            continue
        rows = cursor.execute('SELECT h.file_name, d.username FROM video_hardlink_info_v4 h '
                              'JOIN dir2id d ON d.rowid = h.dir1 WHERE h.md5 = ? COLLATE NOCASE '
                              'ORDER BY h.modify_time DESC LIMIT 8', (token,))
        for name, month in rows:
            if isinstance(month, str) and MONTH.fullmatch(month) and isinstance(name, str) and re.fullmatch(r'[a-fA-F0-9]{32}(?:_raw)?\.mp4', name, re.I):
                yield month, name


def locate_indexed_video(account, entries):
    base = account.resolve() / 'msg' / 'video'
    if base.resolve() != base:
        raise FileNotFoundError('VIDEO_LOCAL_MISSING')
    for month, name in entries:
        candidate = base / month / name
        if not candidate.is_file() or candidate.resolve() != candidate:
            continue
        with candidate.open('rb') as source:
            header = source.read(16)
        if len(header) == 16 and header[4:8] == b'ftyp':
            return candidate
    raise FileNotFoundError('VIDEO_LOCAL_MISSING')


def locate_local_video(account, packed_tokens, hashes):
    if not packed_tokens and not hashes:
        raise FileNotFoundError('VIDEO_LOCAL_MISSING')
    base = account.resolve() / 'msg' / 'video'
    if not base.is_dir() or base.resolve() != base:
        raise FileNotFoundError('VIDEO_LOCAL_MISSING')
    months = sorted((item for item in base.iterdir() if MONTH.fullmatch(item.name) and item.is_dir() and item.resolve() == item),
                    reverse=True)
    for token in dict.fromkeys((*packed_tokens, *hashes)):
        if not TOKEN.fullmatch(token):
            continue
        for month in months:
            for suffix in ('.mp4', '_raw.mp4'):
                candidate = month / (token + suffix)
                if not candidate.is_file() or candidate.resolve() != candidate:
                    continue
                try:
                    with candidate.open('rb') as source:
                        header = source.read(16)
                        if len(header) < 16 or header[4:8] != b'ftyp':
                            continue
                        if token in packed_tokens:
                            return candidate
                        source.seek(0)
                        if hashlib.file_digest(source, 'md5').hexdigest() == token:
                            return candidate
                except FileNotFoundError:
                    continue
    raise FileNotFoundError('VIDEO_LOCAL_MISSING')
