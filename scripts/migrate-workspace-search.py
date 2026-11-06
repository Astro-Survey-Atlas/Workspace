#!/usr/bin/env python3
"""One-time Workspace v1 -> local v2 conversion. Never reads or writes Warehouse.

Source remains intact. Scientific attributes move to bounded evidence chunks.
Run with API dispatch paused. Review the receipt before changing ASTRO_ES_URL.
"""
import argparse
import collections
import gzip
import hashlib
import json
import math
import os
import pathlib
import sqlite3
import time
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('--source', required=True)
parser.add_argument('--target', required=True)
parser.add_argument('--metadata', required=True)
parser.add_argument('--output', required=True)
parser.add_argument('--finalize-only', action='store_true', help='Complete receipts/refresh after a successful copy; never recopy evidence')
args = parser.parse_args()
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
root = pathlib.Path(args.output)
root.mkdir(parents=True, exist_ok=True)
version = 'migration-20261106'


def request(base, route, body=None, method='POST', content_type='application/json'):
    data = body if isinstance(body, bytes) else json.dumps(body).encode() if body is not None else None
    for attempt in range(4):
        try:
            with opener.open(urllib.request.Request(base.rstrip('/') + route, data=data, method=method,
                            headers={'Content-Type': content_type}), timeout=120) as response:
                result = json.load(response)
                if result.get('errors'):
                    failures = [item for item in result.get('items', []) if next(iter(item.values())).get('error')]
                    raise RuntimeError('Elasticsearch rejected a migration item: ' + str(failures[:1]))
                if result.get('timed_out') or result.get('_shards', {}).get('failed', 0):
                    raise RuntimeError('Source search did not complete')
                return result
        except Exception:
            if attempt == 3:
                raise
            time.sleep(min(2 ** attempt, 8))


def ensure(name, properties):
    try:
        request(args.target, '/' + name, {'settings': {'number_of_shards': 1, 'number_of_replicas': 0, 'refresh_interval': '-1'},
                'mappings': {'dynamic': 'strict', 'properties': properties}}, 'PUT')
    except urllib.error.HTTPError as error:
        if error.code != 400 or b'resource_already_exists_exception' not in error.read():
            raise


keyword = {'type': 'keyword'}
position_fields = {key: keyword for key in ['object_id', 'survey', 'release', 'product', 'modality', 'asset_id', 'source_file_id', 'scan_run_id', 'data_batch_id']}
position_fields.update({'ra_deg': {'type': 'double'}, 'dec_deg': {'type': 'double'}, 'sky_position': {'type': 'geo_point'},
                        'healpix_order': {'type': 'byte'}, 'healpix_pixel': {'type': 'integer'}, 'attributes': {'type': 'flattened', 'ignore_above': 8192},
                        'evidence_ref': {'type': 'keyword', 'index': False}})
ensure('astro_position_index_v2', position_fields)
footprint_fields = {key: keyword for key in ['point_id', 'asset_id', 'data_batch_id', 'source_id']}
footprint_fields.update({key: {'type': 'double'} for key in ['ra_min', 'ra_max', 'dec_min', 'dec_max']})
ensure('astro_image_footprint_index_v2', footprint_fields)
file_fields = {key: keyword for key in ['file_id', 'asset_id', 'scan_run_id', 'data_batch_id', 'source_uri', 'survey', 'release', 'product', 'modality', 'spatial_status', 'precision']}
file_fields.update({'coverage_cells': {'type': 'integer'}, 'size_bytes': {'type': 'long'}})
ensure('astro_file_index_v2', file_fields)

metadata = sqlite3.connect(args.metadata)
assets = {value['id']: value for row in metadata.execute('SELECT record FROM data_assets') for value in [json.loads(row[0])]}
runs = {value['id']: value for row in metadata.execute('SELECT record FROM connector_ingest_runs') for value in [json.loads(row[0])]}
quality = {}
for run in sorted(runs.values(), key=lambda run: (run['createdAt'], run['id']), reverse=True):
    if not run.get('parentRunId') and run.get('fitsQualityProfile'):
        for asset in run.get('assetIds') or [run.get('assetId')]:
            quality.setdefault(asset, run['id'])

file_db = sqlite3.connect(root / 'migration-files.sqlite')
file_db.execute('PRAGMA journal_mode=WAL')
file_db.execute('CREATE TABLE IF NOT EXISTS files(asset TEXT, id TEXT, uri TEXT, scan TEXT, PRIMARY KEY(asset,id))')
file_db.execute('CREATE TABLE IF NOT EXISTS cells(asset TEXT,id TEXT,pixel INTEGER,PRIMARY KEY(asset,id,pixel))')
# A row per target id makes deduplication and audit counts explicit across old indices.
file_db.execute('CREATE TABLE IF NOT EXISTS positions(id TEXT PRIMARY KEY,asset TEXT,pixel INTEGER)')


def scroll(index):
    page = request(args.source, '/' + index + '/_search?scroll=10m', {'size': 1000, 'sort': ['_doc'], 'query': {'match_all': {}}})
    scroll_id = page.get('_scroll_id')
    try:
        while page.get('hits', {}).get('hits'):
            yield from page['hits']['hits']
            page = request(args.source, '/_search/scroll', {'scroll': '10m', 'scroll_id': scroll_id})
            scroll_id = page.get('_scroll_id', scroll_id)
    finally:
        if scroll_id:
            request(args.source, '/_search/scroll', {'scroll_id': [scroll_id]}, 'DELETE')


lines = []
bulk_bytes = 0


def flush():
    global lines, bulk_bytes
    if lines:
        request(args.target, '/_bulk', ''.join(lines).encode(), content_type='application/x-ndjson')
        lines = []
        bulk_bytes = 0


def index_document(index, identifier, source):
    global bulk_bytes
    payload = json.dumps({'index': {'_index': index, '_id': identifier}}, separators=(',', ':')) + '\n' + json.dumps(source, separators=(',', ':'), ensure_ascii=False) + '\n'
    size = len(payload.encode())
    if len(lines) >= 1000 or bulk_bytes + size > 2 * 1024 * 1024:
        flush()
    lines.append(payload)
    bulk_bytes += size


evidence_root = root / 'workspace-scans' / version
evidence_root.mkdir(parents=True, exist_ok=True)
chunk_number = 0
chunk = None
chunk_size = 0


def archive(source):
    global chunk_number, chunk, chunk_size
    payload = (json.dumps({'attributes': source.get('attributes', {}), 'originalSource': source}, ensure_ascii=False, separators=(',', ':')) + '\n').encode()
    # Avoid storing the header twice in the original source copy.
    original = dict(source)
    attributes = original.pop('attributes', {})
    payload = (json.dumps({'attributes': attributes, 'originalSource': original}, ensure_ascii=False, separators=(',', ':')) + '\n').encode()
    if len(payload) > 4 * 1024 * 1024:
        raise RuntimeError('Evidence record exceeds bounded detail read size')
    payload = gzip.compress(payload, compresslevel=1, mtime=0)
    if chunk is None or chunk_size + len(payload) > 8 * 1024 * 1024:
        if chunk:
            chunk.close()
        chunk = open(evidence_root / ('part-%06d.ndjson.gz' % chunk_number), 'wb')
        chunk_number += 1
        chunk_size = 0
    reference = '%s/part-%06d.ndjson.gz@%d:%d' % (version, chunk_number - 1, chunk_size, len(payload))
    chunk.write(payload)
    chunk_size += len(payload)
    return reference


counts = collections.Counter()
started = time.monotonic()
if not args.finalize_only:
    for old_index in ['astro_object_index_v1', 'astro_data_point_index_v1']:
        for hit in scroll(old_index):
            source = hit['_source']
            asset = source.get('asset_id')
            if asset not in assets:
                counts['unownedArchivedInSource'] += 1
                continue
            if asset in quality and source.get('data_batch_id') != quality[asset]:
                counts['supersededArchivedInSource'] += 1
                continue
            ra, dec = source.get('ra_deg'), source.get('dec_deg')
            if not isinstance(ra, (float, int)) or not isinstance(dec, (float, int)) or not math.isfinite(ra + dec) or not (0 <= ra < 360 and -90 <= dec <= 90):
                raise RuntimeError('Invalid persisted ICRS position; migration stopped')
            document = {key: value for key, value in source.items() if key in position_fields}
            document['data_batch_id'] = version
            document['evidence_ref'] = archive(source)
            attributes = source.get('attributes', {})
            document['attributes'] = {key: str(value) for key, value in attributes.items() if key in ['source_uri', 'file_name', 'position_role', 'source_id', 'hdu_index']}
            index_document('astro_position_index_v2', hit['_id'], document)
            file_id = source.get('source_file_id')
            uri = attributes.get('source_uri', '')
            old_run = runs.get(source.get('scan_run_id'), {})
            if not uri and old_run.get('fileCount') == 1:
                uri = old_run.get('sourcePath') or old_run.get('target', {}).get('uri', '')
            pixel = source.get('healpix_pixel')
            file_db.execute('INSERT OR REPLACE INTO positions VALUES(?,?,?)', (hit['_id'], asset, pixel))
            if file_id and uri:
                file_db.execute('INSERT OR REPLACE INTO files VALUES(?,?,?,?)', (asset, file_id, uri, source.get('scan_run_id')))
                if pixel is not None:
                    file_db.execute('INSERT OR IGNORE INTO cells VALUES(?,?,?)', (asset, file_id, pixel))
            counts[old_index] += 1
            if sum(counts[key] for key in ['astro_object_index_v1', 'astro_data_point_index_v1']) % 10000 == 0:
                file_db.commit()
                print(json.dumps({'stage': old_index, 'copied': counts[old_index], 'elapsedSeconds': round(time.monotonic()-started)}), flush=True)
        flush()
        file_db.commit()
    if chunk:
        chunk.close()

    for hit in scroll('astro_data_image_footprint_index_v1'):
        source = hit['_source']
        asset = source.get('asset_id')
        if asset not in assets or asset in quality and source.get('data_batch_id') != quality[asset]:
            continue
        if not file_db.execute('SELECT 1 FROM positions WHERE id=?', (source['point_id'],)).fetchone():
            counts['orphanFootprintsArchivedInSource'] += 1
            continue
        document = {key: value for key, value in source.items() if key in footprint_fields}
        document['data_batch_id'] = version
        index_document('astro_image_footprint_index_v2', hit['_id'], document)
        counts['footprints'] += 1
        if counts['footprints'] % 20000 == 0:
            print(json.dumps({'stage': 'footprints', 'copied': counts['footprints']}), flush=True)
    flush()

    for asset_id, file_id, uri, scan in file_db.execute('SELECT asset,id,uri,scan FROM files'):
        asset = assets[asset_id]
        cells = [row[0] for row in file_db.execute('SELECT pixel FROM cells WHERE asset=? AND id=?', (asset_id, file_id))]
        document = {'file_id': file_id, 'asset_id': asset_id, 'scan_run_id': scan, 'data_batch_id': version, 'source_uri': uri,
                    'survey': asset.get('surveyId', 'user'), 'release': asset.get('releaseId', 'user'), 'product': asset.get('product', ''),
                    'modality': (asset.get('modalities') or ['other'])[0], 'spatial_status': 'known' if cells else 'unknown',
                    'coverage_cells': cells, 'precision': 'estimated'}
        identifier = hashlib.sha256((asset_id + '\n' + file_id).encode()).hexdigest()
        index_document('astro_file_index_v2', identifier, document)
        counts['files'] += 1
    flush()

summaries = {}
for asset_id, count in file_db.execute('SELECT asset,count(*) FROM positions GROUP BY asset'):
    cells = [row[0] for row in file_db.execute('SELECT DISTINCT pixel FROM positions WHERE asset=? ORDER BY pixel', (asset_id,)) if row[0] is not None]
    destination = root / 'workspace-scans' / version / (asset_id + '.cells.json')
    destination.write_text(json.dumps(cells, separators=(',', ':')))
    summaries[asset_id] = {'pointCount': count, 'fileCount': file_db.execute('SELECT count(*) FROM files WHERE asset=?', (asset_id,)).fetchone()[0],
                           'pointCoverageRef': version + '/' + destination.name}
for name in ['astro_position_index_v2', 'astro_image_footprint_index_v2', 'astro_file_index_v2']:
    request(args.target, '/' + name + '/_settings', {'index': {'refresh_interval': '5s'}}, 'PUT')
    request(args.target, '/' + name + '/_refresh')
    counts[name] = request(args.target, '/' + name + '/_count', {'query': {'match_all': {}}})['count']
receipt = {'version': version, 'counts': dict(counts), 'assets': summaries, 'elapsedSeconds': round(time.monotonic()-started)}
(root / 'search-migration-receipt.json').write_text(json.dumps(receipt, indent=2))
print(json.dumps({'complete': True, 'counts': dict(counts), 'elapsedSeconds': receipt['elapsedSeconds']}), flush=True)
