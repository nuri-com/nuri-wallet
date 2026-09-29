import type React from "react";

import { NuriIcon } from "@ds";

// The DS spinner: the "spinner" motion glyph — NuriIcon renders it as the
// animated staggered ring (reduced-motion aware). Default size/color come
// from the DS (size.sm, theme text primary).
const Spinner: React.FC = () => <NuriIcon name="spinner" />;

export default Spinner;
