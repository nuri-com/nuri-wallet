import * as React from "react";

import { Alert, AlertIcon, useToast } from "@ds";

import { registerCopiedToast } from "../lib/copyToClipboard";
import { t } from "../lib/i18n";

/**
 * CopyToastBridge — connects the app-wide copyToClipboard() helper to the DS
 * toast runtime. Mounted once inside DsOverlayRoot (within ToastProvider), it
 * captures useToast() and registers the shared "Copied" toast renderer, so any
 * copyToClipboard() call anywhere — including plain onPress handlers and
 * non-hook code — shows the same DS toast. Renders nothing.
 */
export default function CopyToastBridge(): null {
  const toast = useToast();
  React.useEffect(() => {
    registerCopiedToast(() =>
      toast.show(
        <Alert variant="soft" accent="neutral">
          <AlertIcon name="check-circle" />
          {t("common.copied")}
        </Alert>,
      ),
    );
    return () => registerCopiedToast(null);
  }, [toast]);
  return null;
}
