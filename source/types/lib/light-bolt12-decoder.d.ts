declare module "light-bolt12-decoder" {
  interface DecodedBolt12Section {
    name: string;
    tag: number;
    value: unknown;
  }

  interface DecodedBolt12 {
    prefix: string;
    sections: DecodedBolt12Section[];
    expiry?: number;
  }

  export function decode(offer: string): DecodedBolt12;
}
