import { Field, Scalar, Group } from '../wrapped.js';
import { Poseidon } from './poseidon.js';
import { Provable } from '../provable.js';
import { PrivateKey, PublicKey } from './signature.js';
import { bytesToWord, wordToBytes } from '../gadgets/bit-slices.js';
import { Bytes } from '../bytes.js';
import { UInt8 } from '../int.js';

export { encrypt, decrypt, encryptV2, decryptV2 };

type CipherText = {
  publicKey: Group;
  cipherText: Field[];
};

/**
 * @deprecated Use {@link encryptV2} instead.
 * Public Key Encryption, using a given array of {@link Field} elements and encrypts it using a {@link PublicKey}.
 */
function encrypt(message: Field[], otherPublicKey: PublicKey) {
  // key exchange
  let privateKey = Provable.witness(Scalar, () => Scalar.random());
  let publicKey = Group.generator.scale(privateKey);
  let sharedSecret = otherPublicKey.toGroup().scale(privateKey);

  let sponge = new Poseidon.Sponge();
  sponge.absorb(sharedSecret.x); // don't think we need y, that's enough entropy

  // encryption
  let cipherText = [];
  for (let i = 0; i < message.length; i++) {
    let keyStream = sponge.squeeze();
    let encryptedChunk = message[i].add(keyStream);
    cipherText.push(encryptedChunk);
    // absorb for the auth tag (two at a time for saving permutations)
    if (i % 2 === 1) sponge.absorb(cipherText[i - 1]);
    if (i % 2 === 1 || i === message.length - 1) sponge.absorb(cipherText[i]);
  }
  // authentication tag
  let authenticationTag = sponge.squeeze();
  cipherText.push(authenticationTag);

  return { publicKey, cipherText };
}

/**
 * @deprecated Use {@link decryptV2} instead.
 * Decrypts a {@link CipherText} using a {@link PrivateKey}.
 */
function decrypt(
  { publicKey, cipherText }: CipherText,
  privateKey: PrivateKey
) {
  // key exchange
  let sharedSecret = publicKey.scale(privateKey.s);

  let sponge = new Poseidon.Sponge();
  sponge.absorb(sharedSecret.x);
  let authenticationTag = cipherText.pop();

  // decryption
  let message = [];
  for (let i = 0; i < cipherText.length; i++) {
    let keyStream = sponge.squeeze();
    let messageChunk = cipherText[i].sub(keyStream);
    message.push(messageChunk);
    if (i % 2 === 1) sponge.absorb(cipherText[i - 1]);
    if (i % 2 === 1 || i === cipherText.length - 1)
      sponge.absorb(cipherText[i]);
  }
  // authentication tag
  sponge.squeeze().assertEquals(authenticationTag!);

  return message;
}

/**
 * Decrypts a {@link CipherText} using a {@link PrivateKey}.
 */
function decryptV2(
  {
    publicKey,
    cipherText,
    messageLength,
  }: CipherText & { messageLength: number },
  privateKey: PrivateKey
) {
  // key exchange
  const sharedSecret = publicKey.scale(privateKey.s);
  const sponge = new Poseidon.Sponge();
  sponge.absorb(sharedSecret.x);
  const authenticationTag = cipherText.pop();

  // decryption
  const message = [];
  for (let i = 0; i < cipherText.length; i++) {
    // frame bit
    if (i === cipherText.length - 1) sponge.absorb(Field(1));
    else sponge.absorb(Field(0));

    const keyStream = sponge.squeeze();
    const messageChunk = cipherText[i].sub(keyStream);

    // convert to bytes
    const byteMessage = wordToBytes(messageChunk, 32);

    // push the message to our final message array
    message.push(byteMessage);

    if (i % 2 === 1) sponge.absorb(cipherText[i - 1]);
    if (i % 2 === 1 || i === cipherText.length - 1)
      sponge.absorb(cipherText[i]);
  }

  // authentication tag
  sponge.squeeze().assertEquals(authenticationTag!);

  // calculate padding
  const multipleOf = 31;
  const n = Math.ceil(messageLength / multipleOf) * multipleOf;

  // return the message as a flat array of bytes, slice the padding off of the final message
  return Bytes.from(message.flat().slice(0, messageLength - n));
}

/**
 * Public Key Encryption, encrypts Bytes using a {@link PublicKey}.
 */
function encryptV2(
  message: Bytes,
  otherPublicKey: PublicKey
): CipherText & {
  messageLength: number;
} {
  const bytes = message.bytes;
  const messageLength = bytes.length;

  // pad message to a multiple of 31 so that we can append a frame bit to the message
  const multipleOf = 31;
  const n = Math.ceil(messageLength / multipleOf) * multipleOf;

  // create the padding
  const padding = Array.from({ length: n - messageLength }, () =>
    UInt8.from(0)
  );
  message.bytes = bytes.concat(padding);

  // convert message into chunks of 31 bytes
  const chunks = message.chunk(31);

  // key exchange
  const privateKey = Provable.witness(Scalar, () => Scalar.random());
  const publicKey = Group.generator.scale(privateKey);
  const sharedSecret = otherPublicKey.toGroup().scale(privateKey);

  const sponge = new Poseidon.Sponge();
  sponge.absorb(sharedSecret.x);

  // encryption
  const cipherText = [];
  for (let [n, chunk] of chunks.entries()) {
    // attach frame bit if its the last chunk
    // pad with zero frame bit if its any other chunk
    if (n === chunks.length - 1) sponge.absorb(Field(1));
    else sponge.absorb(Field(0));

    const keyStream = sponge.squeeze();
    const encryptedChunk = bytesToWord(chunk).add(keyStream);
    cipherText.push(encryptedChunk);

    // absorb for the auth tag (two at a time for saving permutations)
    if (n % 2 === 1) sponge.absorb(cipherText[n - 1]);
    if (n % 2 === 1 || n === chunks.length - 1) sponge.absorb(cipherText[n]);
  }

  // authentication tag
  const authenticationTag = sponge.squeeze();
  cipherText.push(authenticationTag);

  return { publicKey, cipherText, messageLength };
}
