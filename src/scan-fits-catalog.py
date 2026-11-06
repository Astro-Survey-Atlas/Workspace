"""Stream one FITS table into the same CSV scanner used by local catalogs."""
import csv
import json
import sys

from astropy.io import fits
from workflow_catalog_helpers import resolve_columns, json_value


def main():
    configured = json.load(sys.stdin)
    with fits.open(sys.argv[1], memmap=True) as hdus:
        table = next((hdu for hdu in hdus if getattr(getattr(hdu, 'data', None), 'names', None)), None)
        if table is None:
            raise ValueError('FITS file has no table HDU')
        names = list(table.data.names)
        columns = resolve_columns(names, {key: value for key, value in configured.items() if value})
        extras = [name for name in names if name not in columns.values() and name not in ('id', 'ra', 'dec')]
        with open(sys.argv[2], 'w', newline='', encoding='utf-8') as output:
            writer = csv.writer(output)
            writer.writerow(['id', 'ra', 'dec'] + extras)
            for index, row in enumerate(table.data):
                identifier = json_value(row[columns['id']]) if columns.get('id') else index + 1
                values = [identifier, json_value(row[columns['ra']]), json_value(row[columns['dec']])]
                values.extend(json_value(row[name]) for name in extras)
                writer.writerow(values)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        sys.stderr.write(str(error)[:1000] + '\n')
        sys.exit(1)
