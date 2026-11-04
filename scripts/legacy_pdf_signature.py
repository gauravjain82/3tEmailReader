"""ISO 32000-1 12.8.3.3 adbe.pkcs7.sha1 adapter for pinned pyHanko 0.33.0.

Validate the PDF-to-encapsulated-digest binding separately, then let pyHanko
validate the actual encapsulated CMS message. Never relabel the SubFilter or
rewrite the PDF. Internal pyHanko APIs here require regression tests on upgrades.
"""
import asyncio
import hashlib
import hmac
import re


class LegacyIntegrityError(ValueError):
    pass


def validate_legacy_pdf_signature(signature, context, *, allow_legacy_sha1):
    if not allow_legacy_sha1:
        raise ValueError('Legacy SHA1 PDF format is not allowed without explicit compatibility')
    if signature.sig_object.get('/Type') != '/Sig':
        raise ValueError('Legacy signature object type must be /Sig')
    if signature.seed_value_spec is not None:
        raise ValueError('Legacy PDF signature seed-value constraints require review')

    # Enforce the exact four-element PDF byte range and its one Contents gap.
    # Do this before hashing: malformed/overlapping/negative ranges must fail closed.
    stream = signature.reader.stream
    stream.seek(0)
    data = stream.read()
    ranges = signature.byte_range
    if len(ranges) != 4 or any(not isinstance(n, int) or n < 0 for n in ranges):
        raise LegacyIntegrityError('Malformed legacy PDF ByteRange')
    start, length, second, tail = ranges
    if start != 0 or length <= 0 or second <= length or tail <= 0 or second + tail > len(data):
        raise LegacyIntegrityError('Invalid legacy PDF ByteRange boundaries')
    gap = data[length:second]
    if not re.fullmatch(rb'<[0-9a-fA-F]+>', gap) or bytes.fromhex(gap[1:-1].decode('ascii')) != signature.pkcs7_content:
        raise LegacyIntegrityError('Legacy PDF ByteRange does not exclude exactly its Contents value')
    eci = signature.signed_data['encap_content_info']
    content = eci['content'].native
    if eci['content_type'].native != 'data' or not isinstance(content, bytes) or len(content) != 20:
        raise LegacyIntegrityError('Legacy CMS must encapsulate exactly one 20-byte SHA-1 document digest')
    digest = hashlib.sha1(data[:length] + data[second:second + tail]).digest()
    if not hmac.compare_digest(content, digest):
        raise LegacyIntegrityError('Encapsulated SHA-1 digest does not match the original PDF ByteRange')

    # PDF coverage/DocMDP analysis uses SHA-1 for this format, independently of
    # the CMS SignerInfo digest algorithm (which may be SHA-256).
    signature.external_md_algorithm = 'sha1'
    signature.external_digest = None
    signature.compute_integrity_info()
    return asyncio.run(_validate_cms(signature, context))


async def _validate_cms(signature, context):
    from pyhanko.sign.validation.generic_cms import cms_basic_validation, collect_timing_info
    from pyhanko.sign.validation.status import PdfSignatureStatus
    from pyhanko.sign.general import get_pyca_cryptography_hash
    from cryptography.hazmat.primitives import hashes

    status = signature.summarise_integrity_info()
    # Content timestamps in CMS refer to the encapsulated content, not raw PDF bytes.
    md = hashes.Hash(get_pyca_cryptography_hash(signature.md_algorithm))
    md.update(signature.signed_data['encap_content_info']['content'].native)
    status.update(await collect_timing_info(signature.signer_info, context, raw_digest=md.finalize()))
    status = await cms_basic_validation(
        signature.signed_data, raw_digest=None, validation_context=context,
        status_kwargs=status, key_usage_settings=PdfSignatureStatus.default_usage_constraints(),
    )
    return PdfSignatureStatus(**status)
