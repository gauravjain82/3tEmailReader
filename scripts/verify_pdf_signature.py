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
                roots.extend(load_certs_from_pemder([str(cert_file)]))
    # Intermediate CAs help build the chain; they are not new trust anchors.
    intermediate_folder = folder.parent / 'intermediates'
    if intermediate_folder.exists():
        for cert_file in sorted(intermediate_folder.iterdir()):
            if cert_file.is_file() and cert_file.suffix.lower() in ('.pem', '.crt', '.cer', '.der'):
                intermediates.extend(load_certs_from_pemder([str(cert_file)]))
    return roots, intermediates


def validate_file(filename, trust_dir, *, roots=None, crls=None, allow_fetching=True, allow_legacy_sha1=False):
    from pyhanko.pdf_utils.reader import PdfFileReader
    from pyhanko.sign.validation import validate_pdf_signature, validate_pdf_timestamp
    from pyhanko.sign.validation.status import SignatureCoverageLevel
    from pyhanko_certvalidator import ValidationContext
    from pyhanko_certvalidator.policy_decl import DisallowWeakAlgorithmsPolicy
    from legacy_pdf_signature import validate_legacy_pdf_signature, LegacyIntegrityError

    data = Path(filename).read_bytes()
    result = {'schemaVersion': 1, 'verifier': 'pyHanko-0.33.0',
              'checkedAt': datetime.now(timezone.utc).isoformat(),
              'sha256': hashlib.sha256(data).hexdigest(), 'signatures': [],
              'policy': 'trusted-chain, required revocation data, document integrity, complete final revision',
              'legacySha1Allowed': bool(allow_legacy_sha1),
              'warnings': ['Legacy SHA-1 compatibility enabled; SHA-1 algorithm restriction relaxed explicitly.'] if allow_legacy_sha1 else []}
    reader = PdfFileReader(io.BytesIO(data), strict=True)
    if not reader.embedded_regular_signatures:
        return {**result, 'status': 'UNSIGNED', 'reason': 'No embedded signer signature found'}
    intermediates = []
    if roots is None:
        roots, intermediates = trust_material(trust_dir)
    result['trustedRootCount'] = len(roots)
    for signature in reader.embedded_signatures:
        try:
            policy_options = {'algorithm_usage_policy': DisallowWeakAlgorithmsPolicy(weak_hash_algos=frozenset({'md2', 'md5'}))} if allow_legacy_sha1 else {}
            context = ValidationContext(trust_roots=roots, other_certs=intermediates,
                                        crls=crls, allow_fetching=allow_fetching,
                                        revocation_mode='require', **policy_options)
            if signature.sig_object.get('/Type') == '/DocTimeStamp':
                checked = validate_pdf_timestamp(signature, context)
            elif signature.sig_object.get('/SubFilter') == '/adbe.pkcs7.sha1':
                checked = validate_legacy_pdf_signature(signature, context, allow_legacy_sha1=allow_legacy_sha1)
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
                'details': checked.pretty_print_details(),
                'format': str(signature.sig_object.get('/SubFilter', ''))})
        except LegacyIntegrityError as error:
            result['signatures'].append({'field': signature.field_name, 'status': 'INVALID', 'intact': False, 'details': str(error), 'format': '/adbe.pkcs7.sha1'})
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
        elif any('sha1' in s.get('details', '').lower() and 'not allowed' in s.get('details', '').lower() for s in result['signatures']):
            reason='Legacy SHA-1 signature blocked by default policy. Explicit legacy compatibility is available; trust, revocation and integrity checks remain required.'
        elif any('No path to trust anchor found' in s.get('details', '') for s in result['signatures']):
            reason='Certificate chain does not lead to a configured trusted root. Obtain the verified root CA and any missing intermediate CA certificates; see SETUP.md.'
        elif result['signatures'] and result['signatures'][-1].get('coverage') not in (None, SignatureCoverageLevel.ENTIRE_FILE.name):
            reason='The final signature does not cover the complete PDF file; automatic approval blocked.'
    return {**result, 'status': state, 'reason': reason}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('pdf')
    parser.add_argument('--trust-dir', required=True)
    parser.add_argument('--allow-legacy-sha1', action='store_true', help='Explicitly permit legacy SHA-1; retain trust, revocation and integrity checks')
    args = parser.parse_args()
    logging.basicConfig(level=logging.CRITICAL)
    try:
        result = validate_file(args.pdf, args.trust_dir, allow_legacy_sha1=args.allow_legacy_sha1)
    except Exception as error:
        result = {'schemaVersion': 1, 'status': 'ERROR', 'reason': str(error),
                  'checkedAt': datetime.now(timezone.utc).isoformat(), 'signatures': []}
    print(json.dumps(result, ensure_ascii=True))


if __name__ == '__main__':
    main()
