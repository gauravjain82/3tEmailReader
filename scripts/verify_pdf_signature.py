"""Read-only PDF validation. No certificate from an invoice is made trusted."""
import argparse
import hashlib
import io
import json
import logging
import ssl
from datetime import datetime, timezone
from pathlib import Path


def trust_material(directory):
    from asn1crypto import x509
    from pyhanko.keys import load_certs_from_pemder
    roots, intermediates = [], []
    if hasattr(ssl, 'enum_certificates'):
        for store, target in [('ROOT', roots), ('CA', intermediates)]:
            for data, encoding, trusted_for in ssl.enum_certificates(store):
                document_purposes={'2.5.29.37.0','1.3.6.1.4.1.311.10.3.12','1.2.840.113583.1.1.5'}
                permitted = trusted_for is True or (isinstance(trusted_for, (set, frozenset)) and bool(trusted_for & document_purposes))
                if encoding == 'x509_asn' and (store != 'ROOT' or permitted):
                    target.append(x509.Certificate.load(data))
    folder = Path(directory)
    if folder.exists():
        for cert_file in sorted(folder.iterdir()):
            if cert_file.is_file() and cert_file.suffix.lower() in ('.pem', '.crt', '.cer', '.der'):
                roots.extend(load_certs_from_pemder(str(cert_file)))
    return roots, intermediates


def validate_file(filename, trust_dir, *, roots=None, crls=None, allow_fetching=True):
    from pyhanko.pdf_utils.reader import PdfFileReader
    from pyhanko.sign.validation import validate_pdf_signature, validate_pdf_timestamp
    from pyhanko.sign.validation.status import SignatureCoverageLevel
    from pyhanko_certvalidator import ValidationContext

    data = Path(filename).read_bytes()
    result = {'schemaVersion': 1, 'verifier': 'pyHanko-0.33.0',
              'checkedAt': datetime.now(timezone.utc).isoformat(),
              'sha256': hashlib.sha256(data).hexdigest(), 'signatures': [],
              'policy': 'trusted-chain, required revocation data, document integrity, complete final revision'}
    reader = PdfFileReader(io.BytesIO(data), strict=True)
    if not reader.embedded_regular_signatures:
        return {**result, 'status': 'UNSIGNED', 'reason': 'No embedded signer signature found'}
    intermediates = []
    if roots is None:
        roots, intermediates = trust_material(trust_dir)
    result['trustedRootCount'] = len(roots)
    for signature in reader.embedded_signatures:
        try:
            context = ValidationContext(trust_roots=roots, other_certs=intermediates,
                                        crls=crls, allow_fetching=allow_fetching,
                                        revocation_mode='require')
            if signature.sig_object.get('/Type') == '/DocTimeStamp':
                checked = validate_pdf_timestamp(signature, context)
            else:
                checked = validate_pdf_signature(signature, context, ts_validation_context=context)
            intact, valid = bool(checked.intact), bool(checked.valid)
            if not intact or not valid or getattr(checked, 'revoked', False) or checked.docmdp_ok is False:
                state = 'INVALID'
            elif checked.bottom_line:
                state = 'VALID'
            else:
                state = 'UNKNOWN'
            result['signatures'].append({'field': signature.field_name, 'status': state,
                'intact': intact, 'cryptographicallyValid': valid, 'trusted': bool(checked.trusted),
                'coverage': checked.coverage.name if checked.coverage else None,
                'signer': checked.signing_cert.subject.human_friendly,
                'certificateSha256': checked.signing_cert.sha256.hex(),
                'details': checked.pretty_print_details()})
        except Exception as error:
            result['signatures'].append({'field': signature.field_name, 'status': 'UNKNOWN', 'details': str(error), 'unsupportedFormat': 'not a recognized SubFilter' in str(error)})
    states = [s['status'] for s in result['signatures']]
    if 'INVALID' in states:
        state, reason = 'INVALID', 'A signature failed integrity, revocation or document modification checks'
    elif states and all(s == 'VALID' for s in states) and result['signatures'][-1].get('coverage') == SignatureCoverageLevel.ENTIRE_FILE.name:
        state, reason = 'VALID', 'All signatures passed trust, revocation and integrity checks; final signature covers the complete file'
    else:
        state, reason = 'UNKNOWN', 'Signature trust, revocation information or complete-file coverage could not be established; review signature details'
        unsupported=[s['details'] for s in result['signatures'] if s.get('unsupportedFormat')]
        if unsupported:
            reason='Unsupported PDF signature format; automatic approval blocked: ' + '; '.join(unsupported)
    return {**result, 'status': state, 'reason': reason}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('pdf')
    parser.add_argument('--trust-dir', required=True)
    args = parser.parse_args()
    logging.basicConfig(level=logging.CRITICAL)
    try:
        result = validate_file(args.pdf, args.trust_dir)
    except Exception as error:
        result = {'schemaVersion': 1, 'status': 'ERROR', 'reason': str(error),
                  'checkedAt': datetime.now(timezone.utc).isoformat(), 'signatures': []}
    print(json.dumps(result, ensure_ascii=True))


if __name__ == '__main__':
    main()
