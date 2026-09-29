/**
 * Detached PKCS#7 / CMS creation for PDF signing (`adbe.pkcs7.detached`).
 *
 * The `authenticatedAttributes` order (`contentType`, `signingTime`,
 * `messageDigest`) and the SHA-256 digest follow what Adobe Acrobat itself
 * produces for this sub-filter.
 *
 * When an RFC 3161 authority is configured, the DER-encoded timestamp token is
 * appended as the `signature-time-stamp` (`1.2.840.113549.1.9.16.2.14`)
 * unsigned attribute after signing. `p7.toAsn1()` then serialises the already
 * signed structure without re-signing, because `p7.sign()` populated
 * `contentInfo`.
 */
import forge from 'node-forge';
import type { asn1, pkcs7 } from 'node-forge';
import type { LoadedP12 } from './p12';
import { bytesToBinaryString } from '../binary';
import {
  OID_SIGNATURE_TIME_STAMP,
  requestTimestampToken,
  type TimestampConfig,
} from './timestamp';

/**
 * `@types/node-forge` omits the runtime fields used to splice an unsigned
 * attribute onto the produced `SignerInfo`. Declare the minimal shape relied on
 * here instead of reaching for `any`.
 */
interface ForgeSignedData extends pkcs7.PkcsSignedData {
  /** Populated by `sign()`; each entry carries the raw RSA signature bytes. */
  signers: Array<{ signature: string }>;
  /** The ASN.1 `SignerInfo` nodes, populated by `sign()`. */
  signerInfos: Array<{ value: asn1.Asn1[] }>;
}

/**
 * Build a detached CMS/PKCS#7 SignedData over `content` and return the raw DER.
 *
 * @param content      Bytes covered by the PDF `/ByteRange` (the signed ranges).
 * @param loaded       Unlocked certificate + private key.
 * @param signingTime  Value for the `signing-time` authenticated attribute.
 * @param timestamp    When set, embed an RFC 3161 timestamp token in the signature.
 */
export async function createDetachedCms(
  content: Uint8Array,
  loaded: LoadedP12,
  signingTime: Date = new Date(),
  timestamp?: TimestampConfig | null,
): Promise<Uint8Array> {
  const p7 = forge.pkcs7.createSignedData() as ForgeSignedData;

  p7.content = forge.util.createBuffer(bytesToBinaryString(content));

  // All certificates travel with the signature so validators can build the chain.
  for (const cert of loaded.chain) {
    p7.addCertificate(cert);
  }

  p7.addSigner({
    key: loaded.key,
    certificate: loaded.certificate,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      // forge accepts a parseable date string here and encodes it as UTCTime.
      { type: forge.pki.oids.signingTime, value: signingTime.toISOString() },
      { type: forge.pki.oids.messageDigest },
    ],
  });

  p7.sign({ detached: true });

  if (timestamp) {
    const signer = p7.signers[0];
    if (!signer) {
      throw new Error('The CMS signature did not contain a signer to timestamp.');
    }

    // The timestamp covers the signature value, not the original content.
    const md = forge.md.sha256.create();
    md.update(signer.signature);
    const hash = Uint8Array.from(md.digest().getBytes(), (char) => char.charCodeAt(0));

    const { tokenDer } = await requestTimestampToken(hash, timestamp);
    const tokenAsn1 = forge.asn1.fromDer(bytesToBinaryString(tokenDer), false);

    // unsignedAttrs [1] IMPLICIT: one Attribute { OID signature-time-stamp, SET { token } }.
    const attribute = forge.asn1.create(forge.asn1.Class.CONTEXT_SPECIFIC, 1, true, [
      forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
        forge.asn1.create(
          forge.asn1.Class.UNIVERSAL,
          forge.asn1.Type.OID,
          false,
          forge.asn1.oidToDer(OID_SIGNATURE_TIME_STAMP).getBytes(),
        ),
        forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, [tokenAsn1]),
      ]),
    ]);

    const signerInfo = p7.signerInfos[0];
    if (!signerInfo) {
      throw new Error('The CMS signature did not contain a SignerInfo to timestamp.');
    }
    signerInfo.value.push(attribute);
  }

  const der = forge.asn1.toDer(p7.toAsn1()).getBytes();
  return Uint8Array.from(der, (char) => char.charCodeAt(0));
}

/** Cheap upper bound for the CMS size so we can size the `/Contents` slot. */
export function estimateCmsSize(loaded: LoadedP12, withTimestamp = false): number {
  // Roughly: 2 KB of overhead + the DER of every certificate + signature.
  let certBytes = 0;
  for (const cert of loaded.chain) {
    certBytes += forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes().length;
  }
  // A timestamp token plus its TSA certificate chain is roughly 12 KB.
  return Math.min(64000, certBytes + 4096 + (withTimestamp ? 12000 : 0));
}
