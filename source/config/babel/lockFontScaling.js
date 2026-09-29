module.exports = function lockFontScaling({ types: t }) {
  function getReactNativeBindings(state) {
    if (!state.reactNativeBindings) {
      state.reactNativeBindings = {
        text: new Set(),
        textInput: new Set(),
        namespaces: new Set(),
      };
    }
    return state.reactNativeBindings;
  }

  function isAttrNamed(attr, name) {
    return t.isJSXAttribute(attr) && t.isJSXIdentifier(attr.name) && attr.name.name === name;
  }

  function forceFontScalingOff(attributes) {
    const filtered = attributes.filter(
      (attr) =>
        !isAttrNamed(attr, "allowFontScaling") && !isAttrNamed(attr, "maxFontSizeMultiplier"),
    );

    filtered.push(
      t.jsxAttribute(
        t.jsxIdentifier("allowFontScaling"),
        t.jsxExpressionContainer(t.booleanLiteral(false)),
      ),
      t.jsxAttribute(
        t.jsxIdentifier("maxFontSizeMultiplier"),
        t.jsxExpressionContainer(t.numericLiteral(1)),
      ),
    );

    return filtered;
  }

  function isReactNativeTextElement(openingElement, bindings) {
    const nameNode = openingElement.name;

    if (t.isJSXIdentifier(nameNode)) {
      return bindings.text.has(nameNode.name);
    }

    if (t.isJSXMemberExpression(nameNode)) {
      return (
        t.isJSXIdentifier(nameNode.object) &&
        t.isJSXIdentifier(nameNode.property) &&
        bindings.namespaces.has(nameNode.object.name) &&
        nameNode.property.name === "Text"
      );
    }

    return false;
  }

  function isReactNativeTextInputElement(openingElement, bindings) {
    const nameNode = openingElement.name;

    if (t.isJSXIdentifier(nameNode)) {
      return bindings.textInput.has(nameNode.name);
    }

    if (t.isJSXMemberExpression(nameNode)) {
      return (
        t.isJSXIdentifier(nameNode.object) &&
        t.isJSXIdentifier(nameNode.property) &&
        bindings.namespaces.has(nameNode.object.name) &&
        nameNode.property.name === "TextInput"
      );
    }

    return false;
  }

  return {
    name: "lock-font-scaling",
    visitor: {
      ImportDeclaration(path, state) {
        if (path.node.source.value !== "react-native") return;

        const bindings = getReactNativeBindings(state);

        for (const specifier of path.node.specifiers) {
          if (t.isImportSpecifier(specifier)) {
            const imported = specifier.imported;
            const local = specifier.local;
            if (!t.isIdentifier(imported) || !t.isIdentifier(local)) continue;

            if (imported.name === "Text") bindings.text.add(local.name);
            if (imported.name === "TextInput") bindings.textInput.add(local.name);
          } else if (t.isImportNamespaceSpecifier(specifier)) {
            if (t.isIdentifier(specifier.local)) {
              bindings.namespaces.add(specifier.local.name);
            }
          }
        }
      },

      JSXOpeningElement(path, state) {
        const bindings = getReactNativeBindings(state);

        if (isReactNativeTextElement(path.node, bindings)) {
          path.node.attributes = forceFontScalingOff(path.node.attributes);
          return;
        }

        if (isReactNativeTextInputElement(path.node, bindings)) {
          path.node.attributes = forceFontScalingOff(path.node.attributes);
        }
      },
    },
  };
};
