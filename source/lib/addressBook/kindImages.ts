import type { ImageSourcePropType } from "react-native";
import type { DestinationKind } from "../../screens/addressBook/addressBookModel";

// The marks the home screen draws its rails with (UnifiedHomeScreen): a saved
// destination shows the same logo as the money it pays into. Phone and email
// have no rail, so they keep a DS glyph (see AddressBookScreen).
const BTC_LOGO = require("../../assets/rails/btc.png");
const LIGHTNING_LOGO = require("../../assets/rails/lightning.png");
const SEPA_LOGO = require("../../assets/rails/sepa.png");
const EUR_FLAG = require("../../assets/flags/eur.png");
const USD_FLAG = require("../../assets/flags/usa.png");

export const KIND_IMAGE: Partial<Record<DestinationKind, ImageSourcePropType>> = {
  bitcoin: BTC_LOGO,
  ark: LIGHTNING_LOGO,
  lightning: LIGHTNING_LOGO,
  "base-usdc": USD_FLAG,
  "base-eurc": EUR_FLAG,
  // One 0x address pays from euro or dollar; the home's euro wallet mark.
  evm: EUR_FLAG,
  bank: SEPA_LOGO,
};
