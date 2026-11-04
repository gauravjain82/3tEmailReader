"""Offline cryptographic regression tests: test CAs are never installed or trusted globally."""
import io
import sys
import tempfile
import unittest
from unittest.mock import patch
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from verify_pdf_signature import validate_file, trust_material
from asn1crypto import keys, x509 as asn_x509
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from pyhanko.pdf_utils import generic
from pyhanko.pdf_utils.writer import PdfFileWriter
from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
from pyhanko.sign import signers
from pyhanko_certvalidator.registry import SimpleCertificateStore


class VerificationTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(prefix='invoice-signature-test-')
        self.addCleanup(self.folder.cleanup)
        self.file = Path(self.folder.name) / 'signed.pdf'
        now = datetime.now(timezone.utc)
        self.root_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        root_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'Temporary Test Root')])
        self.root = (x509.CertificateBuilder().subject_name(root_name).issuer_name(root_name)
            .public_key(self.root_key.public_key()).serial_number(1).not_valid_before(now-timedelta(days=1))
            .not_valid_after(now+timedelta(days=30)).add_extension(x509.BasicConstraints(ca=True,path_length=1),True)
            .add_extension(x509.KeyUsage(False,False,False,False,False,True,True,False,False),True)
            .add_extension(x509.SubjectKeyIdentifier.from_public_key(self.root_key.public_key()),False)
            .sign(self.root_key,hashes.SHA256()))
        leaf_key = rsa.generate_private_key(public_exponent=65537,key_size=2048)
        self.leaf = (x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'Invoice Test Signer')]))
            .issuer_name(root_name).public_key(leaf_key.public_key()).serial_number(2)
            .not_valid_before(now-timedelta(days=1)).not_valid_after(now+timedelta(days=15))
            .add_extension(x509.BasicConstraints(ca=False,path_length=None),True)
            .add_extension(x509.KeyUsage(True,True,False,False,False,False,False,False,False),True)
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(self.root_key.public_key()),False)
            .sign(self.root_key,hashes.SHA256()))
        self.roots=[asn_x509.Certificate.load(self.root.public_bytes(serialization.Encoding.DER))]
        store=SimpleCertificateStore();store.register(self.roots[0])
        signer=signers.SimpleSigner(signing_cert=asn_x509.Certificate.load(self.leaf.public_bytes(serialization.Encoding.DER)),
            signing_key=keys.PrivateKeyInfo.load(leaf_key.private_bytes(serialization.Encoding.DER,serialization.PrivateFormat.PKCS8,serialization.NoEncryption())),cert_registry=store)
        self.signer=signer
        writer=PdfFileWriter()
        stream=writer.add_object(generic.StreamObject(stream_data=b'original invoice content'))
        page=generic.DictionaryObject({generic.pdf_name('/Type'):generic.pdf_name('/Page'),generic.pdf_name('/MediaBox'):generic.ArrayObject([generic.NumberObject(x) for x in [0,0,300,300]]),generic.pdf_name('/Resources'):generic.DictionaryObject(),generic.pdf_name('/Contents'):stream})
        writer.insert_page(page)
        unsigned=io.BytesIO();writer.write(unsigned);unsigned.seek(0)
        self.unsigned=unsigned.getvalue()
        signed=io.BytesIO()
        signers.PdfSigner(signers.PdfSignatureMetadata(field_name='Signature1'),signer=signer).sign_pdf(IncrementalPdfFileWriter(unsigned),output=signed)
        self.file.write_bytes(signed.getvalue())
        self.crl=(x509.CertificateRevocationListBuilder().issuer_name(root_name).last_update(now-timedelta(hours=1)).next_update(now+timedelta(days=1))
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(self.root_key.public_key()),False).sign(self.root_key,hashes.SHA256()))

    def check_pdf(self, **kwargs):
        return validate_file(self.file, self.folder.name, roots=self.roots, crls=[self.crl.public_bytes(serialization.Encoding.DER)], allow_fetching=False, **kwargs)

    def test_trusted_signed_pdf_is_valid(self):
        result=self.check_pdf()
        self.assertEqual(result['status'],'VALID',result)
        self.assertTrue(result['signatures'][0]['intact'])

    def test_certificate_files_load_from_root_and_intermediate_folders(self):
        roots=Path(self.folder.name)/'trusted-roots';roots.mkdir()
        intermediates=roots.parent/'intermediates';intermediates.mkdir()
        (roots/'root.cer').write_bytes(self.root.public_bytes(serialization.Encoding.DER))
        now=datetime.now(timezone.utc)
        intermediate=(x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'Temporary Test Intermediate')]))
            .issuer_name(self.root.subject).public_key(self.root_key.public_key()).serial_number(3)
            .not_valid_before(now-timedelta(days=1)).not_valid_after(now+timedelta(days=10))
            .add_extension(x509.BasicConstraints(ca=True,path_length=0),True).sign(self.root_key,hashes.SHA256()))
        (intermediates/'issuer.pem').write_bytes(intermediate.public_bytes(serialization.Encoding.PEM))
        with patch('ssl.enum_certificates',return_value=[],create=True):
            loaded_roots,loaded_intermediates=trust_material(roots)
        self.assertEqual(len(loaded_roots),1);self.assertEqual(len(loaded_intermediates),1)
        self.assertEqual(loaded_roots[0].dump(),self.root.public_bytes(serialization.Encoding.DER))
        self.assertEqual(loaded_intermediates[0].dump(),intermediate.public_bytes(serialization.Encoding.DER))

    def test_tampered_pdf_is_invalid(self):
        self.file.write_bytes(self.file.read_bytes().replace(b'original invoice content',b'modified invoice content'))
        self.assertEqual(self.check_pdf()['status'],'INVALID')

    def test_unknown_ca_is_not_approved(self):
        result=validate_file(self.file,self.folder.name,roots=[],allow_fetching=False)
        self.assertNotEqual(result['status'],'VALID')

    def test_no_revocation_information_is_not_approved(self):
        result=validate_file(self.file,self.folder.name,roots=self.roots,allow_fetching=False)
        self.assertNotEqual(result['status'],'VALID')

    def test_revoked_signer_is_not_approved(self):
        now=datetime.now(timezone.utc)
        revoked=x509.RevokedCertificateBuilder().serial_number(2).revocation_date(now-timedelta(hours=2)).build()
        self.crl=(x509.CertificateRevocationListBuilder().issuer_name(self.root.subject)
            .last_update(now-timedelta(hours=1)).next_update(now+timedelta(days=1))
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(self.root_key.public_key()),False)
            .add_revoked_certificate(revoked).sign(self.root_key,hashes.SHA256()))
        self.assertNotEqual(self.check_pdf()['status'],'VALID')

    def test_unsigned_pdf_is_not_approved(self):
        self.file.write_bytes(self.unsigned)
        self.assertEqual(self.check_pdf()['status'],'UNSIGNED')

    def sign_legacy(self):
        signed=io.BytesIO()
        signers.PdfSigner(signers.PdfSignatureMetadata(field_name='Signature1',md_algorithm='sha1'),signer=self.signer).sign_pdf(IncrementalPdfFileWriter(io.BytesIO(self.unsigned)),output=signed)
        self.file.write_bytes(signed.getvalue())

    def test_sha1_requires_explicit_compatibility_and_then_all_checks_pass(self):
        self.sign_legacy()
        blocked=self.check_pdf()
        self.assertEqual(blocked['status'],'UNKNOWN',blocked)
        self.assertIn('SHA-1',blocked['reason'])
        approved=self.check_pdf(allow_legacy_sha1=True)
        self.assertEqual(approved['status'],'VALID',approved)
        self.assertTrue(approved['legacySha1Allowed'])
        self.assertTrue(approved['warnings'])

    def test_legacy_compatibility_does_not_approve_tampered_document(self):
        self.sign_legacy()
        self.file.write_bytes(self.file.read_bytes().replace(b'original invoice content',b'modified invoice content'))
        self.assertEqual(self.check_pdf(allow_legacy_sha1=True)['status'],'INVALID')

    def test_legacy_compatibility_does_not_approve_untrusted_signer(self):
        self.sign_legacy()
        result=validate_file(self.file,self.folder.name,roots=[],allow_fetching=False,allow_legacy_sha1=True)
        self.assertNotEqual(result['status'],'VALID')

    def test_legacy_compatibility_does_not_approve_missing_revocation(self):
        self.sign_legacy()
        result=validate_file(self.file,self.folder.name,roots=self.roots,allow_fetching=False,allow_legacy_sha1=True)
        self.assertNotEqual(result['status'],'VALID')

    def test_legacy_compatibility_does_not_approve_revoked_signer(self):
        self.sign_legacy()
        now=datetime.now(timezone.utc)
        revoked=x509.RevokedCertificateBuilder().serial_number(2).revocation_date(now-timedelta(hours=2)).build()
        self.crl=(x509.CertificateRevocationListBuilder().issuer_name(self.root.subject)
            .last_update(now-timedelta(hours=1)).next_update(now+timedelta(days=1))
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(self.root_key.public_key()),False)
            .add_revoked_certificate(revoked).sign(self.root_key,hashes.SHA256()))
        self.assertNotEqual(self.check_pdf(allow_legacy_sha1=True)['status'],'VALID')


if __name__=='__main__':
    unittest.main()
