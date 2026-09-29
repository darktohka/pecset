# Pecsét

Digitally sign PDF files **entirely in the browser** with a `.p12` / `.pfx` certificate.

[Head to Pecsét now!](https://pecset.tohka.us)

---

## Features

| Feature | Status |
| --- | --- |
| Sign with a `.p12` / `.pfx` certificate (RSA + SHA-256, `adbe.pkcs7.detached`) | ✅ |
| Password-protected certificates, validated **as you type** | ✅ |
| Certificate details (name, issuer, validity, fingerprint) shown on unlock | ✅ |
| Save certificates (and optionally passwords) in IndexedDB for reuse | ✅ |
| **Invisible** signature - cryptographic signature only | ✅ |
| **Adobe-style visible** signature - signer name + date | ✅ |
| **Custom visible** signature - upload a PNG/JPEG | ✅ |
| Drag, resize, rotate visible signatures directly on the page | ✅ |
| Move a signature across pages | ✅ |
| **Signature chains** - sign a document that already has signatures without breaking them | ✅ |
| **Finalise** (certification / locking signature) or **continue** the chain | ✅ |
| Optional RFC 3161 timestamp on every signature | ✅ |
| Custom signing date & time (when no timestamp authority is used) | ✅ |
| Optionally set the PDF creation/modification date (unmodified / signature date / custom) | ✅ |

---

## Quick start

```bash
bun install
bun run dev        # http://localhost:5173
```

Then:

1. **Certificates → Import** a `.p12`/`.pfx`. Type the password; the certificate
   is validated on every keystroke and its identity is shown immediately.
2. **Open a PDF.**
3. Pick a signature type and add it. The new signature is placed at the centre
   of the page currently on screen; drag, resize or rotate it, and drag it onto
   any other page to move it.
4. **Sign, allow more** to keep the document open to further signatures, or
   **Sign & finalise** to lock it.
5. Download the result.

### Scripts

| Command | Purpose |
| --- | --- |
| `bun run dev` | Vite dev server |
| `bun run build` | Type-check + production build |
| `bun run typecheck` | `tsc -b` only |
| `bun run test` | Unit tests (Vitest) |
| `bun run verify:sign` | End-to-end: signs a local PDF with a local `signer.p12`, writes `out/signed-chain.pdf`, then runs `pdfsig` |

The real certificate and reference PDF are **not committed** (`.gitignore`
excludes `*.p12` / `*.pdf`), so `verify:sign` expects them to be present
locally. The unit tests never touch them: they generate a throwaway PKCS#12 and
PDF in memory (`tests/helpers/dummyFixtures.ts`).

---

## How signing works

The hard requirement is **signature chains**: signing a PDF that already
contains a signature must not invalidate it. A PDF signature covers an explicit
`/ByteRange`, so the original bytes must never change - the only legal way to
add a signature is an **incremental update**: append the new objects plus a new
cross-reference section and trailer, leaving everything before it byte-for-byte
identical.

That constraint drives the whole design:

```
signPdf()
  │
  ├─ @cantoo/pdf-lib  PDFDocument.load(bytes, { forIncrementalUpdate: true })
  │      • parses the whole document, including xref streams and object streams
  │      • edit page /Annots, AcroForm /Fields, /SigFlags, catalog /Perms
  │
  ├─ build an /AP appearance form XObject (Adobe-style vector, image, or empty)
  │      • rotation baked in via a `cm` matrix; widget /Rect grown to the rotated AABB
  │
  ├─ write the signature dictionary with placeholders
  │      • /ByteRange [0 /********** /********** /**********]
  │      • /Contents <0000…>  (zero-filled, fixed width)
  │
  ├─ doc.save()  →  original bytes + appended increment
  │
  ├─ prepareSignaturePlaceholder()   src/lib/pdf/byteRange.ts
  │      • locate /Contents, fill in the real /ByteRange numbers (length preserving)
  │      • return the exact bytes covered by the signature
  │
  ├─ createDetachedCms()             src/lib/crypto/cms.ts
  │      • node-forge PKCS#7 SignedData, SHA-256, detached
  │      • authenticated attributes: contentType, signingTime, messageDigest
  │      • when timestamping: request an RFC 3161 token over the signature
  │        value and splice it in as an unsigned signature-time-stamp attribute
  │
  └─ insertCms()  →  DER hex-spliced into /Contents, zero padded
```

Each placement produces its own appended revision, so signing *n* placements
yields a chain of *n* signatures - exactly what Acrobat does.

### Timestamps and dates

When you tick **Add a trusted timestamp (RFC 3161)**, every real signature gets
a `signature-time-stamp` **unsigned** CMS attribute (OID
`1.2.840.113549.1.9.16.2.14`). The token is requested over a SHA-256 digest of
the signature value itself, the `SignerInfo.signature` octets, matching
RFC 3161 §2.4.1. Because the attribute is unsigned it is not covered by the
signer's signature: it is spliced in after signing and the signed bytes never
change.

The preset authorities are limited to CAs trusted by Adobe, Windows or Apple:
Sectigo, SwissSign, GlobalSign, Digicert, Izenpe, Azure, QuoVadis, Certum and
Apple. All of them are fronted by the `rfc3161.ai.moda` relay, which adds the
CORS headers a browser needs; **Sectigo** is the default. The authority URL
stays editable.

With timestamping off, the signing time comes from either **Current date &
time** or a **Custom date & time**. A custom value feeds the signature
appearance, the PDF `/M` entry and the CMS `signing-time` attribute, so all
three agree. When a custom signing time is set, an optional checkbox controls
the document's Info `/CreationDate` and `/ModDate` (plus the XMP date fields
when the file carries them): leave them **Unmodified**, change them to the
**signature date**, or set a **custom date**. The override is applied to the
first real-signature revision only, and it is skipped for an already-certified
document so the certification stays intact.

### Why these libraries

- **`@cantoo/pdf-lib`** - the maintained pdf-lib fork with genuine
  **incremental update** support (`forIncrementalUpdate`, `saveIncremental`,
  `commit`). Upstream `pdf-lib` rewrites the whole file on `save()`, which
  invalidates every existing signature. We verified this empirically: after a
  plain `pdf-lib` re-save, `pdfsig` reports
  `Illegal values in ByteRange array / Not total document signed`.
- **`node-forge`** - PKCS#12 parsing and detached CMS. It decodes the
  PBES2 / PBKDF2 / AES-256-CBC container used by modern certificates, and its
  `browser` field means **no Node polyfills** are needed under Vite.
- **`pdf.js`** - page rasterisation in the viewer.
- **`idb`** - IndexedDB certificate store.
- **`zustand`** - application state.

Drag, resize and rotate, and moving a placement from one page to another, are
handled by a small custom pointer-event layer in the viewer rather than a drag
library. Keeping the interaction in-house means the signature box and its
selection frame are always in agreement, and a placement can be dragged
seamlessly across pages: a fixed-position drag ghost follows the cursor while
the drop page is chosen by hit-testing the page elements. The pure math for
these gestures lives in `src/components/viewer/geometry.ts`.

We deliberately did **not** use `@signpdf/placeholder-plain`: it only handles
*classic* xref tables, so it fails on this project's own reference PDF
(`Expected xref at NaN`) because that file's latest revision is an **xref
stream**. `@signpdf/placeholder-pdf-lib` avoids the parse problem but breaks
prior signatures because it saves with upstream pdf-lib. Their crypto layer is
sound, but the placeholder writers are the fragile part, so the placeholder and
byte-range handling are implemented here instead.

---

## Security model

- All processing happens client-side. There is no server component and no
  network request that carries the document or the certificate.
- **RFC 3161 timestamping is the one feature that makes a network request.**
  When it is enabled, the browser sends only a SHA-256 digest of the signature
  value to the chosen authority, relayed through `rfc3161.ai.moda`. The
  document, the certificate and the private key are never sent. With
  timestamping off, no request that carries signing material leaves the machine.
- Certificates you choose to keep are stored in **IndexedDB** as the raw
  `.p12`/`.pfx` bytes plus the extracted public identity.
- Storing a password is **opt-in per certificate**. If you decline, the password
  is never written to disk and is re-prompted on each use. A password held only
  in memory lives in a module-local `Map` and is never persisted.
- IndexedDB is origin-scoped and is **not** encrypted. Anyone with access to the
  browser profile (or a script running on the same origin) could read a stored
  `.p12` and, if you chose to remember it, the password. Only enable
  "Remember password" on a machine you control.

---

## Coordinate conventions

Getting these wrong is the classic source of bugs, so they are stated explicitly:

- A `SignaturePlacement` stores `cx` / `cy` as the **centre** of the box, in PDF
  user-space points (origin bottom-left, **y up**), plus the **unrotated**
  `width` / `height` and a `rotation` in degrees.
- In the PDF the rotation is applied as the matrix `cos sin −sin cos 0 0`
  (counter-clockwise in PDF space) about the box centre, and the widget `/Rect`
  is grown to the axis-aligned bounding box of the rotated box.
- On screen the y axis is flipped, so a counter-clockwise rotation in PDF space
  appears **clockwise**. The overlay therefore feeds `placement.rotation`
  straight into a CSS `rotate()` transform with no negation, so the mapping is
  1:1 by construction.

---

## Known limitations

- **Text font.** The Adobe-style appearance draws text with a standard PDF font
  (Helvetica / WinAnsi). Characters outside WinAnsi are transliterated
  (`ő → ö`, `ű → ü`, `ș → ş`, …) - see `pdfSafeText`. Full Unicode would require
  embedding a TrueType font via a fontkit build; that dependency was judged too
  large (~12 MB) for the benefit. The *cryptographic* signature always carries
  the exact certificate name; only the rendered appearance is transliterated.
- **Encrypted PDFs** (password/owner-protected) are rejected with a clear error.
- **Certification signatures must be first.** A "finalise" signature applies a
  DocMDP transform (`/Perms /DocMDP`, `/P 1`, no further changes) and is only
  valid as the document's first signature. When signatures already exist, the
  app says so and falls back to an ordinary approval signature instead of
  producing a file that verifiers would reject.
- Validity of the signer's certificate is not evaluated against a trust list -
  the app reports the certificate's own dates and fingerprint, and delegates
  trust decisions to the reader that opens the signed PDF.
- **No strict PAdES.** The signature SubFilter stays `adbe.pkcs7.detached`.
  Adobe and Acrobat recognise the RFC 3161 signature timestamp, but strict
  **PAdES-B-T** (`ETSI.CAdES.detached` plus the ESS `signing-certificate-v2`
  attribute) is not implemented.

---

## Verification

`bun run verify:sign` signs the already-signed reference document three times
(Adobe-style, custom image, rotated Adobe-style) plus once invisibly, and also
signs a timestamped signature and a custom-document-date signature. Every real
signature is verified with `pdfsig`. Expected output includes
`Signature is Valid.` for **every** signature, including the one that was
already in the file:

```text
before: 3 pages, signatures=1 [Signature2:true]
signed: … bytes (+… appended)
after:  3 pages, signatures=5 [Signature2:true, Signature1:true, Signature3:true, Signature4:true, Signature5:true]

Signature #1  Dana Example          Signature is Valid.
Signature #2  Dummy Signer          Signature is Valid.
Signature #3  Dummy Signer          Signature is Valid.
Signature #4  Dummy Signer          Signature is Valid.
Signature #5  Dummy Signer          Total document signed  Signature is Valid.
```

(`Certificate Validation: Certificate has Expired` is expected when the local
test certificate has expired.)

---

## Layout

```
src/
  types.ts                     shared domain types and typed errors
  lib/
    binary.ts                  byte <-> string helpers
    crypto/
      p12.ts                   PKCS#12 parsing, password validation, identity
      cms.ts                   detached PKCS#7 SignedData
      timestamp.ts             RFC 3161 timestamp client and authority presets
    pdf/
      appearance.ts            appearance streams (Adobe-style, image, empty)
      byteRange.ts             /ByteRange preparation and CMS splicing
      documentDates.ts         Info + XMP creation/modification date control
      inspect.ts               page + signature-field inspection
      render.ts                pdf.js loading and rasterisation
      sign.ts                  signing orchestration (incremental)
    storage/certStore.ts       IndexedDB certificate persistence
  state/useAppStore.ts         application state
  components/                  Header, EmptyState, DocumentViewer, SignaturePanel,
                               CertificateManager, ResultBanner
    viewer/geometry.ts         pure drag / resize / rotate / hit-test math
scripts/verify-sign.ts         end-to-end signing check
tests/                         unit tests for byte-range and crypto
```
