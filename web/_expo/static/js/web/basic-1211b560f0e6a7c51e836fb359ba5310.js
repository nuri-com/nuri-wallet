__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0});var n=r(d[0]);Object.keys(n).forEach(function(t){"default"!==t&&"__esModule"!==t&&(t in e&&e[t]===n[t]||Object.defineProperty(e,t,{enumerable:!0,get:function(){return n[t]}}))});var t=r(d[1]);Object.keys(t).forEach(function(n){"default"!==n&&"__esModule"!==n&&(n in e&&e[n]===t[n]||Object.defineProperty(e,n,{enumerable:!0,get:function(){return t[n]}}))});var u=r(d[2]);Object.keys(u).forEach(function(n){"default"!==n&&"__esModule"!==n&&(n in e&&e[n]===u[n]||Object.defineProperty(e,n,{enumerable:!0,get:function(){return u[n]}}))})},6903,[6908,6999,7028]);
__d(function(g,_r,_i,a,m,e,_d){Object.defineProperty(e,"__esModule",{value:!0}),e.W3mConnectingWcBasicView=void 0;var t=_r(_d[0]),l=_r(_d[1]),i=_r(_d[2]),n=_r(_d[3]);_r(_d[4]),_r(_d[5]),_r(_d[6]),_r(_d[7]);var o=this&&this.__decorate||function(t,l,i,n){var o,c=arguments.length,r=c<3?l:null===n?n=Object.getOwnPropertyDescriptor(l,i):n;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)r=Reflect.decorate(t,l,i,n);else for(var s=t.length-1;s>=0;s--)(o=t[s])&&(r=(c<3?o(r):c>3?o(l,i,r):o(l,i))||r);return c>3&&r&&Object.defineProperty(l,i,r),r};let c=e.W3mConnectingWcBasicView=class extends t.LitElement{constructor(){super(...arguments),this.isMobile=i.CoreHelperUtil.isMobile()}render(){if(this.isMobile){const{featured:l,recommended:n}=i.ApiController.state,{customWallets:o}=i.OptionsController.state,c=i.StorageUtil.getRecentWallets(),r=l.length||n.length||o?.length||c.length;return t.html`<wui-flex
        flexDirection="column"
        gap="xs"
        .margin=${['3xs','s','s','s']}
      >
        ${r?t.html`<w3m-connector-list></w3m-connector-list>`:null}
        <w3m-all-wallets-widget></w3m-all-wallets-widget>
      </wui-flex>`}return t.html`<wui-flex flexDirection="column" .padding=${['0','0','l','0']}>
      <w3m-connecting-wc-view></w3m-connecting-wc-view>
      <wui-flex flexDirection="column" .padding=${['0','m','0','m']}>
        <w3m-all-wallets-widget></w3m-all-wallets-widget> </wui-flex
    ></wui-flex>`}};o([(0,l.state)()],c.prototype,"isMobile",void 0),e.W3mConnectingWcBasicView=c=o([(0,n.customElement)('w3m-connecting-wc-basic-view')],c)},6908,[4951,4960,4631,4948,4971,6909,6917,6928]);
__d(function(g,_r,_i,a,m,e,_d){Object.defineProperty(e,"__esModule",{value:!0}),e.W3mAllWalletsWidget=void 0;var t=_r(_d[0]),l=_r(_d[1]),o=_r(_d[2]),n=_r(_d[3]),s=_r(_d[4]);_r(_d[5]);var i=this&&this.__decorate||function(t,l,o,n){var s,i=arguments.length,r=i<3?l:null===n?n=Object.getOwnPropertyDescriptor(l,o):n;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)r=Reflect.decorate(t,l,o,n);else for(var c=t.length-1;c>=0;c--)(s=t[c])&&(r=(i<3?s(r):i>3?s(l,o,r):s(l,o))||r);return i>3&&r&&Object.defineProperty(l,o,r),r};let r=e.W3mAllWalletsWidget=class extends t.LitElement{constructor(){super(),this.unsubscribe=[],this.tabIdx=void 0,this.connectors=n.ConnectorController.state.connectors,this.count=n.ApiController.state.count,this.filteredCount=n.ApiController.state.filteredWallets.length,this.isFetchingRecommendedWallets=n.ApiController.state.isFetchingRecommendedWallets,this.unsubscribe.push(n.ConnectorController.subscribeKey('connectors',t=>this.connectors=t),n.ApiController.subscribeKey('count',t=>this.count=t),n.ApiController.subscribeKey('filteredWallets',t=>this.filteredCount=t.length),n.ApiController.subscribeKey('isFetchingRecommendedWallets',t=>this.isFetchingRecommendedWallets=t))}disconnectedCallback(){this.unsubscribe.forEach(t=>t())}render(){const l=this.connectors.find(t=>'walletConnect'===t.id),{allWallets:s}=n.OptionsController.state;if(!l||'HIDE'===s)return null;if('ONLY_MOBILE'===s&&!n.CoreHelperUtil.isMobile())return null;const i=n.ApiController.state.featured.length,r=this.count+i,c=r<10?r:10*Math.floor(r/10),d=this.filteredCount>0?this.filteredCount:c;let h=`${d}`;return this.filteredCount>0?h=`${this.filteredCount}`:d<r&&(h=`${d}+`),t.html`
      <wui-list-wallet
        name="All Wallets"
        walletIcon="allWallets"
        showAllWallets
        @click=${this.onAllWallets.bind(this)}
        tagLabel=${h}
        tagVariant="shade"
        data-testid="all-wallets"
        tabIdx=${(0,o.ifDefined)(this.tabIdx)}
        .loading=${this.isFetchingRecommendedWallets}
        loadingSpinnerColor=${this.isFetchingRecommendedWallets?'fg-300':'accent-100'}
      ></wui-list-wallet>
    `}onAllWallets(){n.EventsController.sendEvent({type:'track',event:'CLICK_ALL_WALLETS'}),n.RouterController.push('AllWallets')}};i([(0,l.property)()],r.prototype,"tabIdx",void 0),i([(0,l.state)()],r.prototype,"connectors",void 0),i([(0,l.state)()],r.prototype,"count",void 0),i([(0,l.state)()],r.prototype,"filteredCount",void 0),i([(0,l.state)()],r.prototype,"isFetchingRecommendedWallets",void 0),e.W3mAllWalletsWidget=r=i([(0,s.customElement)('w3m-all-wallets-widget')],r)},6909,[4951,4960,4974,4631,4948,6910]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0});var n=r(d[0]);Object.keys(n).forEach(function(t){"default"!==t&&"__esModule"!==t&&(t in e&&e[t]===n[t]||Object.defineProperty(e,t,{enumerable:!0,get:function(){return n[t]}}))})},6910,[6911]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.WuiListWallet=void 0;var l=_r(_d[1]),i=_r(_d[2]),o=_r(_d[3]);_r(_d[4]),_r(_d[5]),_r(_d[6]);var r=_r(_d[7]),s=_r(_d[8]);_r(_d[9]),_r(_d[10]),_r(_d[11]);var n=t(_r(_d[12])),p=this&&this.__decorate||function(t,l,i,o){var r,s=arguments.length,n=s<3?l:null===o?o=Object.getOwnPropertyDescriptor(l,i):o;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)n=Reflect.decorate(t,l,i,o);else for(var p=t.length-1;p>=0;p--)(r=t[p])&&(n=(s<3?r(n):s>3?r(l,i,n):r(l,i))||n);return s>3&&n&&Object.defineProperty(l,i,n),n};let h=e.WuiListWallet=class extends l.LitElement{constructor(){super(...arguments),this.walletImages=[],this.imageSrc='',this.name='',this.tabIdx=void 0,this.installed=!1,this.disabled=!1,this.showAllWallets=!1,this.loading=!1,this.loadingSpinnerColor='accent-100'}render(){return l.html`
      <button ?disabled=${this.disabled} tabindex=${(0,o.ifDefined)(this.tabIdx)}>
        ${this.templateAllWallets()} ${this.templateWalletImage()}
        <wui-text variant="paragraph-500" color="inherit">${this.name}</wui-text>
        ${this.templateStatus()}
      </button>
    `}templateAllWallets(){return this.showAllWallets&&this.imageSrc?l.html` <wui-all-wallets-image .imageeSrc=${this.imageSrc}> </wui-all-wallets-image> `:this.showAllWallets&&this.walletIcon?l.html` <wui-wallet-image .walletIcon=${this.walletIcon} size="sm"> </wui-wallet-image> `:null}templateWalletImage(){return!this.showAllWallets&&this.imageSrc?l.html`<wui-wallet-image
        size="sm"
        imageSrc=${this.imageSrc}
        name=${this.name}
        .installed=${this.installed}
      ></wui-wallet-image>`:this.showAllWallets||this.imageSrc?null:l.html`<wui-wallet-image size="sm" name=${this.name}></wui-wallet-image>`}templateStatus(){return this.loading?l.html`<wui-loading-spinner
        size="lg"
        color=${this.loadingSpinnerColor}
      ></wui-loading-spinner>`:this.tagLabel&&this.tagVariant?l.html`<wui-tag variant=${this.tagVariant}>${this.tagLabel}</wui-tag>`:this.icon?l.html`<wui-icon color="inherit" size="sm" name=${this.icon}></wui-icon>`:null}};h.styles=[r.resetStyles,r.elementStyles,n.default],p([(0,i.property)({type:Array})],h.prototype,"walletImages",void 0),p([(0,i.property)()],h.prototype,"imageSrc",void 0),p([(0,i.property)()],h.prototype,"name",void 0),p([(0,i.property)()],h.prototype,"tagLabel",void 0),p([(0,i.property)()],h.prototype,"tagVariant",void 0),p([(0,i.property)()],h.prototype,"icon",void 0),p([(0,i.property)()],h.prototype,"walletIcon",void 0),p([(0,i.property)()],h.prototype,"tabIdx",void 0),p([(0,i.property)({type:Boolean})],h.prototype,"installed",void 0),p([(0,i.property)({type:Boolean})],h.prototype,"disabled",void 0),p([(0,i.property)({type:Boolean})],h.prototype,"showAllWallets",void 0),p([(0,i.property)({type:Boolean})],h.prototype,"loading",void 0),p([(0,i.property)({type:String})],h.prototype,"loadingSpinnerColor",void 0),e.WuiListWallet=h=p([(0,s.customElement)('wui-list-wallet')],h)},6911,[2,4951,4960,4974,4976,4985,4989,4950,4959,6912,4993,6913,6916]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.WuiAllWalletsImage=void 0;var l=_r(_d[1]),i=_r(_d[2]),r=_r(_d[3]);_r(_d[4]);var s=_r(_d[5]),o=_r(_d[6]);_r(_d[7]),_r(_d[8]);var c=t(_r(_d[9])),n=this&&this.__decorate||function(t,l,i,r){var s,o=arguments.length,c=o<3?l:null===r?r=Object.getOwnPropertyDescriptor(l,i):r;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)c=Reflect.decorate(t,l,i,r);else for(var n=t.length-1;n>=0;n--)(s=t[n])&&(c=(o<3?s(c):o>3?s(l,i,c):s(l,i))||c);return o>3&&c&&Object.defineProperty(l,i,c),c};let u=e.WuiAllWalletsImage=class extends l.LitElement{constructor(){super(...arguments),this.walletImages=[]}render(){const t=this.walletImages.length<4;return l.html`${this.walletImages.slice(0,4).map(({src:t,walletName:i})=>l.html`
            <wui-wallet-image
              size="inherit"
              imageSrc=${t}
              name=${(0,r.ifDefined)(i)}
            ></wui-wallet-image>
          `)}
      ${t?[...Array(4-this.walletImages.length)].map(()=>l.html` <wui-wallet-image size="inherit" name=""></wui-wallet-image>`):null}
      <wui-flex>
        <wui-icon-box
          size="xxs"
          iconSize="xxs"
          iconcolor="success-100"
          backgroundcolor="success-100"
          icon="checkmark"
          background="opaque"
        ></wui-icon-box>
      </wui-flex>`}};u.styles=[s.resetStyles,c.default],n([(0,i.property)({type:Array})],u.prototype,"walletImages",void 0),e.WuiAllWalletsImage=u=n([(0,o.customElement)('wui-all-wallets-image')],u)},6912,[2,4951,4960,4974,4972,4950,4959,4989,6913,6915]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.WuiWalletImage=void 0;var i=_r(_d[1]),l=_r(_d[2]);_r(_d[3]),_r(_d[4]),_r(_d[5]);var r=_r(_d[6]),o=_r(_d[7]);_r(_d[8]);var s=t(_r(_d[9])),n=this&&this.__decorate||function(t,i,l,r){var o,s=arguments.length,n=s<3?i:null===r?r=Object.getOwnPropertyDescriptor(i,l):r;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)n=Reflect.decorate(t,i,l,r);else for(var c=t.length-1;c>=0;c--)(o=t[c])&&(n=(s<3?o(n):s>3?o(i,l,n):o(i,l))||n);return s>3&&n&&Object.defineProperty(i,l,n),n};let c=e.WuiWalletImage=class extends i.LitElement{constructor(){super(...arguments),this.size='md',this.name='',this.installed=!1,this.badgeSize='xs'}render(){let t='xxs';return t='lg'===this.size?'m':'md'===this.size?'xs':'xxs',this.style.cssText=`\n       --local-border-radius: var(--wui-border-radius-${t});\n       --local-size: var(--wui-wallet-image-size-${this.size});\n   `,this.walletIcon&&(this.dataset.walletIcon=this.walletIcon),i.html`
      <wui-flex justifyContent="center" alignItems="center"> ${this.templateVisual()} </wui-flex>
    `}templateVisual(){return this.imageSrc?i.html`<wui-image src=${this.imageSrc} alt=${this.name}></wui-image>`:this.walletIcon?i.html`<wui-icon
        data-parent-size="md"
        size="md"
        color="inherit"
        name=${this.walletIcon}
      ></wui-icon>`:i.html`<wui-icon
      data-parent-size=${this.size}
      size="inherit"
      color="inherit"
      name="walletPlaceholder"
    ></wui-icon>`}};c.styles=[r.elementStyles,r.resetStyles,s.default],n([(0,l.property)()],c.prototype,"size",void 0),n([(0,l.property)()],c.prototype,"name",void 0),n([(0,l.property)()],c.prototype,"imageSrc",void 0),n([(0,l.property)()],c.prototype,"walletIcon",void 0),n([(0,l.property)({type:Boolean})],c.prototype,"installed",void 0),n([(0,l.property)()],c.prototype,"badgeSize",void 0),e.WuiWalletImage=c=n([(0,o.customElement)('wui-wallet-image')],c)},6913,[2,4951,4960,4976,4991,4972,4950,4959,4989,6914]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var o=r(d[0]);e.default=o.css`
  :host {
    position: relative;
    background-color: var(--wui-color-gray-glass-002);
    display: flex;
    justify-content: center;
    align-items: center;
    width: var(--local-size);
    height: var(--local-size);
    border-radius: inherit;
    border-radius: var(--local-border-radius);
  }

  :host > wui-flex {
    overflow: hidden;
    border-radius: inherit;
    border-radius: var(--local-border-radius);
  }

  :host::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    right: 0;
    border-radius: inherit;
    border: 1px solid var(--wui-color-gray-glass-010);
    pointer-events: none;
  }

  :host([name='Extension'])::after {
    border: 1px solid var(--wui-color-accent-glass-010);
  }

  :host([data-wallet-icon='allWallets']) {
    background-color: var(--wui-all-wallets-bg-100);
  }

  :host([data-wallet-icon='allWallets'])::after {
    border: 1px solid var(--wui-color-accent-glass-010);
  }

  wui-icon[data-parent-size='inherit'] {
    width: 75%;
    height: 75%;
    align-items: center;
  }

  wui-icon[data-parent-size='sm'] {
    width: 18px;
    height: 18px;
  }

  wui-icon[data-parent-size='md'] {
    width: 24px;
    height: 24px;
  }

  wui-icon[data-parent-size='lg'] {
    width: 42px;
    height: 42px;
  }

  wui-icon[data-parent-size='full'] {
    width: 100%;
    height: 100%;
  }

  :host > wui-icon-box {
    position: absolute;
    overflow: hidden;
    right: -1px;
    bottom: -2px;
    z-index: 1;
    border: 2px solid var(--wui-color-bg-150, #1e1f1f);
    padding: 1px;
  }
`},6914,[4951]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var o=r(d[0]);e.default=o.css`
  :host {
    position: relative;
    border-radius: var(--wui-border-radius-xxs);
    width: 40px;
    height: 40px;
    overflow: hidden;
    background: var(--wui-color-gray-glass-002);
    display: flex;
    justify-content: center;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--wui-spacing-4xs);
    padding: 3.75px !important;
  }

  :host::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    right: 0;
    border-radius: inherit;
    border: 1px solid var(--wui-color-gray-glass-010);
    pointer-events: none;
  }

  :host > wui-wallet-image {
    width: 14px;
    height: 14px;
    border-radius: var(--wui-border-radius-5xs);
  }

  :host > wui-flex {
    padding: 2px;
    position: fixed;
    overflow: hidden;
    left: 34px;
    bottom: 8px;
    background: var(--dark-background-150, #1e1f1f);
    border-radius: 50%;
    z-index: 2;
    display: flex;
  }
`},6915,[4951]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var o=r(d[0]);e.default=o.css`
  button {
    column-gap: var(--wui-spacing-s);
    padding: 7px var(--wui-spacing-l) 7px var(--wui-spacing-xs);
    width: 100%;
    background-color: var(--wui-color-gray-glass-002);
    border-radius: var(--wui-border-radius-xs);
    color: var(--wui-color-fg-100);
  }

  button > wui-text:nth-child(2) {
    display: flex;
    flex: 1;
  }

  button:disabled {
    background-color: var(--wui-color-gray-glass-015);
    color: var(--wui-color-gray-glass-015);
  }

  button:disabled > wui-tag {
    background-color: var(--wui-color-gray-glass-010);
    color: var(--wui-color-fg-300);
  }

  wui-icon {
    color: var(--wui-color-fg-200) !important;
  }
`},6916,[4951]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.W3mConnectorList=void 0;var n=_r(_d[1]),c=_r(_d[2]),o=_r(_d[3]),r=_r(_d[4]),i=_r(_d[5]);_r(_d[6]),_r(_d[7]),_r(_d[8]),_r(_d[9]),_r(_d[10]),_r(_d[11]),_r(_d[12]),_r(_d[13]),_r(_d[14]),_r(_d[15]);var d=_r(_d[16]),s=t(_r(_d[17])),l=this&&this.__decorate||function(t,n,c,o){var r,i=arguments.length,d=i<3?n:null===o?o=Object.getOwnPropertyDescriptor(n,c):o;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)d=Reflect.decorate(t,n,c,o);else for(var s=t.length-1;s>=0;s--)(r=t[s])&&(d=(i<3?r(d):i>3?r(n,c,d):r(n,c))||d);return i>3&&d&&Object.defineProperty(n,c,d),d};let u=e.W3mConnectorList=class extends n.LitElement{constructor(){super(),this.unsubscribe=[],this.tabIdx=void 0,this.connectors=r.ConnectorController.state.connectors,this.recommended=r.ApiController.state.recommended,this.featured=r.ApiController.state.featured,this.unsubscribe.push(r.ConnectorController.subscribeKey('connectors',t=>this.connectors=t),r.ApiController.subscribeKey('recommended',t=>this.recommended=t),r.ApiController.subscribeKey('featured',t=>this.featured=t))}disconnectedCallback(){this.unsubscribe.forEach(t=>t())}render(){return n.html`
      <wui-flex flexDirection="column" gap="xs"> ${this.connectorListTemplate()} </wui-flex>
    `}connectorListTemplate(){const{custom:t,recent:c,announced:r,injected:i,multiChain:s,recommended:l,featured:u,external:h}=d.ConnectorUtil.getConnectorsByType(this.connectors,this.recommended,this.featured);return d.ConnectorUtil.getConnectorTypeOrder({custom:t,recent:c,announced:r,injected:i,multiChain:s,recommended:l,featured:u,external:h}).map(t=>{switch(t){case'injected':return n.html`
            ${s.length?n.html`<w3m-connect-multi-chain-widget
                  tabIdx=${(0,o.ifDefined)(this.tabIdx)}
                ></w3m-connect-multi-chain-widget>`:null}
            ${r.length?n.html`<w3m-connect-announced-widget
                  tabIdx=${(0,o.ifDefined)(this.tabIdx)}
                ></w3m-connect-announced-widget>`:null}
            ${i.length?n.html`<w3m-connect-injected-widget
                  .connectors=${i}
                  tabIdx=${(0,o.ifDefined)(this.tabIdx)}
                ></w3m-connect-injected-widget>`:null}
          `;case'walletConnect':return n.html`<w3m-connect-walletconnect-widget
            tabIdx=${(0,o.ifDefined)(this.tabIdx)}
          ></w3m-connect-walletconnect-widget>`;case'recent':return n.html`<w3m-connect-recent-widget
            tabIdx=${(0,o.ifDefined)(this.tabIdx)}
          ></w3m-connect-recent-widget>`;case'featured':return n.html`<w3m-connect-featured-widget
            .wallets=${u}
            tabIdx=${(0,o.ifDefined)(this.tabIdx)}
          ></w3m-connect-featured-widget>`;case'custom':return n.html`<w3m-connect-custom-widget
            tabIdx=${(0,o.ifDefined)(this.tabIdx)}
          ></w3m-connect-custom-widget>`;case'external':return n.html`<w3m-connect-external-widget
            tabIdx=${(0,o.ifDefined)(this.tabIdx)}
          ></w3m-connect-external-widget>`;case'recommended':return n.html`<w3m-connect-recommended-widget
            .wallets=${l}
            tabIdx=${(0,o.ifDefined)(this.tabIdx)}
          ></w3m-connect-recommended-widget>`;default:return console.warn(`Unknown connector type: ${t}`),null}})}};u.styles=s.default,l([(0,c.property)()],u.prototype,"tabIdx",void 0),l([(0,c.state)()],u.prototype,"connectors",void 0),l([(0,c.state)()],u.prototype,"recommended",void 0),l([(0,c.state)()],u.prototype,"featured",void 0),e.W3mConnectorList=u=l([(0,i.customElement)('w3m-connector-list')],u)},6917,[2,4951,4960,4974,4631,4948,4971,6918,6919,6920,6921,6922,6923,6924,6925,6926,4936,6927]);
__d(function(g,_r,_i,a,m,e,_d){Object.defineProperty(e,"__esModule",{value:!0}),e.W3mConnectAnnouncedWidget=void 0;var t=_r(_d[0]),n=_r(_d[1]),o=_r(_d[2]),c=_r(_d[3]),r=_r(_d[4]);_r(_d[5]),_r(_d[6]);var l=_r(_d[7]),i=this&&this.__decorate||function(t,n,o,c){var r,l=arguments.length,i=l<3?n:null===c?c=Object.getOwnPropertyDescriptor(n,o):c;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)i=Reflect.decorate(t,n,o,c);else for(var s=t.length-1;s>=0;s--)(r=t[s])&&(i=(l<3?r(i):l>3?r(n,o,i):r(n,o))||i);return l>3&&i&&Object.defineProperty(n,o,i),i};let s=e.W3mConnectAnnouncedWidget=class extends t.LitElement{constructor(){super(),this.unsubscribe=[],this.tabIdx=void 0,this.connectors=c.ConnectorController.state.connectors,this.unsubscribe.push(c.ConnectorController.subscribeKey('connectors',t=>this.connectors=t))}disconnectedCallback(){this.unsubscribe.forEach(t=>t())}render(){const n=this.connectors.filter(t=>'ANNOUNCED'===t.type);return n?.length?t.html`
      <wui-flex flexDirection="column" gap="xs">
        ${n.filter(l.ConnectorUtil.showConnector).map(n=>t.html`
              <wui-list-wallet
                imageSrc=${(0,o.ifDefined)(c.AssetUtil.getConnectorImage(n))}
                name=${n.name??'Unknown'}
                @click=${()=>this.onConnector(n)}
                tagVariant="success"
                tagLabel="installed"
                data-testid=${`wallet-selector-${n.id}`}
                .installed=${!0}
                tabIdx=${(0,o.ifDefined)(this.tabIdx)}
              >
              </wui-list-wallet>
            `)}
      </wui-flex>
    `:(this.style.cssText="display: none",null)}onConnector(t){'walletConnect'===t.id?c.CoreHelperUtil.isMobile()?c.RouterController.push('AllWallets'):c.RouterController.push('ConnectingWalletConnect'):c.RouterController.push('ConnectingExternal',{connector:t})}};i([(0,n.property)()],s.prototype,"tabIdx",void 0),i([(0,n.state)()],s.prototype,"connectors",void 0),e.W3mConnectAnnouncedWidget=s=i([(0,r.customElement)('w3m-connect-announced-widget')],s)},6918,[4951,4960,4974,4631,4948,4971,6910,4936]);
__d(function(g,_r,_i,a,m,e,_d){Object.defineProperty(e,"__esModule",{value:!0}),e.W3mConnectCustomWidget=void 0;var t=_r(_d[0]),o=_r(_d[1]),n=_r(_d[2]),i=_r(_d[3]),l=_r(_d[4]);_r(_d[5]),_r(_d[6]);var s=this&&this.__decorate||function(t,o,n,i){var l,s=arguments.length,r=s<3?o:null===i?i=Object.getOwnPropertyDescriptor(o,n):i;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)r=Reflect.decorate(t,o,n,i);else for(var c=t.length-1;c>=0;c--)(l=t[c])&&(r=(s<3?l(r):s>3?l(o,n,r):l(o,n))||r);return s>3&&r&&Object.defineProperty(o,n,r),r};let r=e.W3mConnectCustomWidget=class extends t.LitElement{constructor(){super(),this.unsubscribe=[],this.tabIdx=void 0,this.connectors=i.ConnectorController.state.connectors,this.loading=!1,this.unsubscribe.push(i.ConnectorController.subscribeKey('connectors',t=>this.connectors=t)),i.CoreHelperUtil.isTelegram()&&i.CoreHelperUtil.isIos()&&(this.loading=!i.ConnectionController.state.wcUri,this.unsubscribe.push(i.ConnectionController.subscribeKey('wcUri',t=>this.loading=!t)))}disconnectedCallback(){this.unsubscribe.forEach(t=>t())}render(){const{customWallets:o}=i.OptionsController.state;if(!o?.length)return this.style.cssText="display: none",null;const l=this.filterOutDuplicateWallets(o);return t.html`<wui-flex flexDirection="column" gap="xs">
      ${l.map(o=>t.html`
          <wui-list-wallet
            imageSrc=${(0,n.ifDefined)(i.AssetUtil.getWalletImage(o))}
            name=${o.name??'Unknown'}
            @click=${()=>this.onConnectWallet(o)}
            data-testid=${`wallet-selector-${o.id}`}
            tabIdx=${(0,n.ifDefined)(this.tabIdx)}
            ?loading=${this.loading}
          >
          </wui-list-wallet>
        `)}
    </wui-flex>`}filterOutDuplicateWallets(t){const o=i.StorageUtil.getRecentWallets(),n=this.connectors.map(t=>t.info?.rdns).filter(Boolean),l=o.map(t=>t.rdns).filter(Boolean),s=n.concat(l);if(s.includes('io.metamask.mobile')&&i.CoreHelperUtil.isMobile()){const t=s.indexOf('io.metamask.mobile');s[t]='io.metamask'}return t.filter(t=>!s.includes(String(t?.rdns)))}onConnectWallet(t){this.loading||i.RouterController.push('ConnectingWalletConnect',{wallet:t})}};s([(0,o.property)()],r.prototype,"tabIdx",void 0),s([(0,o.state)()],r.prototype,"connectors",void 0),s([(0,o.state)()],r.prototype,"loading",void 0),e.W3mConnectCustomWidget=r=s([(0,l.customElement)('w3m-connect-custom-widget')],r)},6919,[4951,4960,4974,4631,4948,4971,6910]);
__d(function(g,_r,_i,a,m,e,_d){Object.defineProperty(e,"__esModule",{value:!0}),e.W3mConnectExternalWidget=void 0;var t=_r(_d[0]),n=_r(_d[1]),o=_r(_d[2]),r=_r(_d[3]),c=_r(_d[4]),i=_r(_d[5]);_r(_d[6]),_r(_d[7]);var l=_r(_d[8]),s=this&&this.__decorate||function(t,n,o,r){var c,i=arguments.length,l=i<3?n:null===r?r=Object.getOwnPropertyDescriptor(n,o):r;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)l=Reflect.decorate(t,n,o,r);else for(var s=t.length-1;s>=0;s--)(c=t[s])&&(l=(i<3?c(l):i>3?c(n,o,l):c(n,o))||l);return i>3&&l&&Object.defineProperty(n,o,l),l};let d=e.W3mConnectExternalWidget=class extends t.LitElement{constructor(){super(),this.unsubscribe=[],this.tabIdx=void 0,this.connectors=c.ConnectorController.state.connectors,this.unsubscribe.push(c.ConnectorController.subscribeKey('connectors',t=>this.connectors=t))}disconnectedCallback(){this.unsubscribe.forEach(t=>t())}render(){const n=this.connectors.filter(t=>'EXTERNAL'===t.type).filter(l.ConnectorUtil.showConnector).filter(t=>t.id!==r.ConstantsUtil.CONNECTOR_ID.COINBASE_SDK);return n?.length?t.html`
      <wui-flex flexDirection="column" gap="xs">
        ${n.map(n=>t.html`
            <wui-list-wallet
              imageSrc=${(0,o.ifDefined)(c.AssetUtil.getConnectorImage(n))}
              .installed=${!0}
              name=${n.name??'Unknown'}
              data-testid=${`wallet-selector-external-${n.id}`}
              @click=${()=>this.onConnector(n)}
              tabIdx=${(0,o.ifDefined)(this.tabIdx)}
            >
            </wui-list-wallet>
          `)}
      </wui-flex>
    `:(this.style.cssText="display: none",null)}onConnector(t){c.RouterController.push('ConnectingExternal',{connector:t})}};s([(0,n.property)()],d.prototype,"tabIdx",void 0),s([(0,n.state)()],d.prototype,"connectors",void 0),e.W3mConnectExternalWidget=d=s([(0,i.customElement)('w3m-connect-external-widget')],d)},6920,[4951,4960,4974,4610,4631,4948,4971,6910,4936]);
__d(function(g,_r,_i,a,m,e,_d){Object.defineProperty(e,"__esModule",{value:!0}),e.W3mConnectFeaturedWidget=void 0;var t=_r(_d[0]),l=_r(_d[1]),n=_r(_d[2]),o=_r(_d[3]),i=_r(_d[4]);_r(_d[5]),_r(_d[6]);var r=this&&this.__decorate||function(t,l,n,o){var i,r=arguments.length,c=r<3?l:null===o?o=Object.getOwnPropertyDescriptor(l,n):o;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)c=Reflect.decorate(t,l,n,o);else for(var s=t.length-1;s>=0;s--)(i=t[s])&&(c=(r<3?i(c):r>3?i(l,n,c):i(l,n))||c);return r>3&&c&&Object.defineProperty(l,n,c),c};let c=e.W3mConnectFeaturedWidget=class extends t.LitElement{constructor(){super(...arguments),this.tabIdx=void 0,this.wallets=[]}render(){return this.wallets.length?t.html`
      <wui-flex flexDirection="column" gap="xs">
        ${this.wallets.map(l=>t.html`
            <wui-list-wallet
              data-testid=${`wallet-selector-featured-${l.id}`}
              imageSrc=${(0,n.ifDefined)(o.AssetUtil.getWalletImage(l))}
              name=${l.name??'Unknown'}
              @click=${()=>this.onConnectWallet(l)}
              tabIdx=${(0,n.ifDefined)(this.tabIdx)}
            >
            </wui-list-wallet>
          `)}
      </wui-flex>
    `:(this.style.cssText="display: none",null)}onConnectWallet(t){o.ConnectorController.selectWalletConnector(t)}};r([(0,l.property)()],c.prototype,"tabIdx",void 0),r([(0,l.property)()],c.prototype,"wallets",void 0),e.W3mConnectFeaturedWidget=c=r([(0,i.customElement)('w3m-connect-featured-widget')],c)},6921,[4951,4960,4974,4631,4948,4971,6910]);
__d(function(g,_r,_i,a,m,e,_d){Object.defineProperty(e,"__esModule",{value:!0}),e.W3mConnectInjectedWidget=void 0;var t=_r(_d[0]),n=_r(_d[1]),o=_r(_d[2]),c=_r(_d[3]),r=_r(_d[4]);_r(_d[5]),_r(_d[6]);var i=_r(_d[7]),l=this&&this.__decorate||function(t,n,o,c){var r,i=arguments.length,l=i<3?n:null===c?c=Object.getOwnPropertyDescriptor(n,o):c;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)l=Reflect.decorate(t,n,o,c);else for(var s=t.length-1;s>=0;s--)(r=t[s])&&(l=(i<3?r(l):i>3?r(n,o,l):r(n,o))||l);return i>3&&l&&Object.defineProperty(n,o,l),l};let s=e.W3mConnectInjectedWidget=class extends t.LitElement{constructor(){super(...arguments),this.tabIdx=void 0,this.connectors=[]}render(){const n=this.connectors.filter(i.ConnectorUtil.showConnector);return 0===n.length?(this.style.cssText="display: none",null):t.html`
      <wui-flex flexDirection="column" gap="xs">
        ${n.map(n=>t.html`
            <wui-list-wallet
              imageSrc=${(0,o.ifDefined)(c.AssetUtil.getConnectorImage(n))}
              .installed=${!0}
              name=${n.name??'Unknown'}
              tagVariant="success"
              tagLabel="installed"
              data-testid=${`wallet-selector-${n.id}`}
              @click=${()=>this.onConnector(n)}
              tabIdx=${(0,o.ifDefined)(this.tabIdx)}
            >
            </wui-list-wallet>
          `)}
      </wui-flex>
    `}onConnector(t){c.ConnectorController.setActiveConnector(t),c.RouterController.push('ConnectingExternal',{connector:t})}};l([(0,n.property)()],s.prototype,"tabIdx",void 0),l([(0,n.property)()],s.prototype,"connectors",void 0),e.W3mConnectInjectedWidget=s=l([(0,r.customElement)('w3m-connect-injected-widget')],s)},6922,[4951,4960,4974,4631,4948,4971,6910,4936]);
__d(function(g,_r,_i,a,m,e,_d){Object.defineProperty(e,"__esModule",{value:!0}),e.W3mConnectMultiChainWidget=void 0;var t=_r(_d[0]),n=_r(_d[1]),o=_r(_d[2]),i=_r(_d[3]),c=_r(_d[4]);_r(_d[5]),_r(_d[6]);var r=this&&this.__decorate||function(t,n,o,i){var c,r=arguments.length,l=r<3?n:null===i?i=Object.getOwnPropertyDescriptor(n,o):i;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)l=Reflect.decorate(t,n,o,i);else for(var s=t.length-1;s>=0;s--)(c=t[s])&&(l=(r<3?c(l):r>3?c(n,o,l):c(n,o))||l);return r>3&&l&&Object.defineProperty(n,o,l),l};let l=e.W3mConnectMultiChainWidget=class extends t.LitElement{constructor(){super(),this.unsubscribe=[],this.tabIdx=void 0,this.connectors=i.ConnectorController.state.connectors,this.unsubscribe.push(i.ConnectorController.subscribeKey('connectors',t=>this.connectors=t))}disconnectedCallback(){this.unsubscribe.forEach(t=>t())}render(){const n=this.connectors.filter(t=>'MULTI_CHAIN'===t.type&&'WalletConnect'!==t.name);return n?.length?t.html`
      <wui-flex flexDirection="column" gap="xs">
        ${n.map(n=>t.html`
            <wui-list-wallet
              imageSrc=${(0,o.ifDefined)(i.AssetUtil.getConnectorImage(n))}
              .installed=${!0}
              name=${n.name??'Unknown'}
              tagVariant="shade"
              tagLabel="multichain"
              data-testid=${`wallet-selector-${n.id}`}
              @click=${()=>this.onConnector(n)}
              tabIdx=${(0,o.ifDefined)(this.tabIdx)}
            >
            </wui-list-wallet>
          `)}
      </wui-flex>
    `:(this.style.cssText="display: none",null)}onConnector(t){i.ConnectorController.setActiveConnector(t),i.RouterController.push('ConnectingMultiChain')}};r([(0,n.property)()],l.prototype,"tabIdx",void 0),r([(0,n.state)()],l.prototype,"connectors",void 0),e.W3mConnectMultiChainWidget=l=r([(0,c.customElement)('w3m-connect-multi-chain-widget')],l)},6923,[4951,4960,4974,4631,4948,4971,6910]);
__d(function(g,_r,_i,a,m,e,_d){Object.defineProperty(e,"__esModule",{value:!0}),e.W3mConnectRecentWidget=void 0;var t=_r(_d[0]),n=_r(_d[1]),o=_r(_d[2]),i=_r(_d[3]),l=_r(_d[4]);_r(_d[5]),_r(_d[6]);var r=_r(_d[7]),s=this&&this.__decorate||function(t,n,o,i){var l,r=arguments.length,s=r<3?n:null===i?i=Object.getOwnPropertyDescriptor(n,o):i;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)s=Reflect.decorate(t,n,o,i);else for(var c=t.length-1;c>=0;c--)(l=t[c])&&(s=(r<3?l(s):r>3?l(n,o,s):l(n,o))||s);return r>3&&s&&Object.defineProperty(n,o,s),s};let c=e.W3mConnectRecentWidget=class extends t.LitElement{constructor(){super(),this.unsubscribe=[],this.tabIdx=void 0,this.connectors=i.ConnectorController.state.connectors,this.loading=!1,this.unsubscribe.push(i.ConnectorController.subscribeKey('connectors',t=>this.connectors=t)),i.CoreHelperUtil.isTelegram()&&i.CoreHelperUtil.isIos()&&(this.loading=!i.ConnectionController.state.wcUri,this.unsubscribe.push(i.ConnectionController.subscribeKey('wcUri',t=>this.loading=!t)))}render(){const n=i.StorageUtil.getRecentWallets().filter(t=>!r.WalletUtil.isExcluded(t)).filter(t=>!this.hasWalletConnector(t)).filter(t=>this.isWalletCompatibleWithCurrentChain(t));return n.length?t.html`
      <wui-flex flexDirection="column" gap="xs">
        ${n.map(n=>t.html`
            <wui-list-wallet
              imageSrc=${(0,o.ifDefined)(i.AssetUtil.getWalletImage(n))}
              name=${n.name??'Unknown'}
              @click=${()=>this.onConnectWallet(n)}
              tagLabel="recent"
              tagVariant="shade"
              tabIdx=${(0,o.ifDefined)(this.tabIdx)}
              ?loading=${this.loading}
            >
            </wui-list-wallet>
          `)}
      </wui-flex>
    `:(this.style.cssText="display: none",null)}onConnectWallet(t){this.loading||i.ConnectorController.selectWalletConnector(t)}hasWalletConnector(t){return this.connectors.some(n=>n.id===t.id||n.name===t.name)}isWalletCompatibleWithCurrentChain(t){const n=i.ChainController.state.activeChain;return!n||!t.chains||t.chains.some(t=>{const o=t.split(':')[0];return n===o})}};s([(0,n.property)()],c.prototype,"tabIdx",void 0),s([(0,n.state)()],c.prototype,"connectors",void 0),s([(0,n.state)()],c.prototype,"loading",void 0),e.W3mConnectRecentWidget=c=s([(0,l.customElement)('w3m-connect-recent-widget')],c)},6924,[4951,4960,4974,4631,4948,4971,6910,4946]);
__d(function(g,_r,_i,a,m,e,_d){Object.defineProperty(e,"__esModule",{value:!0}),e.W3mConnectRecommendedWidget=void 0;var t=_r(_d[0]),n=_r(_d[1]),l=_r(_d[2]),o=_r(_d[3]),i=_r(_d[4]);_r(_d[5]),_r(_d[6]);var r=_r(_d[7]),s=this&&this.__decorate||function(t,n,l,o){var i,r=arguments.length,s=r<3?n:null===o?o=Object.getOwnPropertyDescriptor(n,l):o;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)s=Reflect.decorate(t,n,l,o);else for(var c=t.length-1;c>=0;c--)(i=t[c])&&(s=(r<3?i(s):r>3?i(n,l,s):i(n,l))||s);return r>3&&s&&Object.defineProperty(n,l,s),s};let c=e.W3mConnectRecommendedWidget=class extends t.LitElement{constructor(){super(),this.unsubscribe=[],this.tabIdx=void 0,this.wallets=[],this.loading=!1,o.CoreHelperUtil.isTelegram()&&o.CoreHelperUtil.isIos()&&(this.loading=!o.ConnectionController.state.wcUri,this.unsubscribe.push(o.ConnectionController.subscribeKey('wcUri',t=>this.loading=!t)))}render(){const{connectors:n}=o.ConnectorController.state,{customWallets:i,featuredWalletIds:s}=o.OptionsController.state,c=o.StorageUtil.getRecentWallets(),d=n.find(t=>'walletConnect'===t.id),u=n.filter(t=>'INJECTED'===t.type||'ANNOUNCED'===t.type||'MULTI_CHAIN'===t.type).filter(t=>'Browser Wallet'!==t.name);if(!d)return null;if(s||i||!this.wallets.length)return this.style.cssText="display: none",null;const p=u.length+c.length,h=Math.max(0,2-p),f=r.WalletUtil.filterOutDuplicateWallets(this.wallets).slice(0,h);return f.length?t.html`
      <wui-flex flexDirection="column" gap="xs">
        ${f.map(n=>t.html`
            <wui-list-wallet
              imageSrc=${(0,l.ifDefined)(o.AssetUtil.getWalletImage(n))}
              name=${n?.name??'Unknown'}
              @click=${()=>this.onConnectWallet(n)}
              tabIdx=${(0,l.ifDefined)(this.tabIdx)}
              ?loading=${this.loading}
            >
            </wui-list-wallet>
          `)}
      </wui-flex>
    `:(this.style.cssText="display: none",null)}onConnectWallet(t){if(this.loading)return;const n=o.ConnectorController.getConnector(t.id,t.rdns);n?o.RouterController.push('ConnectingExternal',{connector:n}):o.RouterController.push('ConnectingWalletConnect',{wallet:t})}};s([(0,n.property)()],c.prototype,"tabIdx",void 0),s([(0,n.property)()],c.prototype,"wallets",void 0),s([(0,n.state)()],c.prototype,"loading",void 0),e.W3mConnectRecommendedWidget=c=s([(0,i.customElement)('w3m-connect-recommended-widget')],c)},6925,[4951,4960,4974,4631,4948,4971,6910,4946]);
__d(function(g,_r,_i,a,m,e,_d){Object.defineProperty(e,"__esModule",{value:!0}),e.W3mConnectWalletConnectWidget=void 0;var t=_r(_d[0]),n=_r(_d[1]),o=_r(_d[2]),c=_r(_d[3]),r=_r(_d[4]);_r(_d[5]);var s=this&&this.__decorate||function(t,n,o,c){var r,s=arguments.length,l=s<3?n:null===c?c=Object.getOwnPropertyDescriptor(n,o):c;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)l=Reflect.decorate(t,n,o,c);else for(var i=t.length-1;i>=0;i--)(r=t[i])&&(l=(s<3?r(l):s>3?r(n,o,l):r(n,o))||l);return s>3&&l&&Object.defineProperty(n,o,l),l};let l=e.W3mConnectWalletConnectWidget=class extends t.LitElement{constructor(){super(),this.unsubscribe=[],this.tabIdx=void 0,this.connectors=c.ConnectorController.state.connectors,this.connectorImages=c.AssetController.state.connectorImages,this.unsubscribe.push(c.ConnectorController.subscribeKey('connectors',t=>this.connectors=t),c.AssetController.subscribeKey('connectorImages',t=>this.connectorImages=t))}disconnectedCallback(){this.unsubscribe.forEach(t=>t())}render(){if(c.CoreHelperUtil.isMobile())return this.style.cssText="display: none",null;const n=this.connectors.find(t=>'walletConnect'===t.id);if(!n)return this.style.cssText="display: none",null;const r=n.imageUrl||this.connectorImages[n?.imageId??''];return t.html`
      <wui-list-wallet
        imageSrc=${(0,o.ifDefined)(r)}
        name=${n.name??'Unknown'}
        @click=${()=>this.onConnector(n)}
        tagLabel="qr code"
        tagVariant="main"
        tabIdx=${(0,o.ifDefined)(this.tabIdx)}
        data-testid="wallet-selector-walletconnect"
      >
      </wui-list-wallet>
    `}onConnector(t){c.ConnectorController.setActiveConnector(t),c.RouterController.push('ConnectingWalletConnect')}};s([(0,n.property)()],l.prototype,"tabIdx",void 0),s([(0,n.state)()],l.prototype,"connectors",void 0),s([(0,n.state)()],l.prototype,"connectorImages",void 0),e.W3mConnectWalletConnectWidget=l=s([(0,r.customElement)('w3m-connect-walletconnect-widget')],l)},6926,[4951,4960,4974,4631,4948,6910]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var c=r(d[0]);e.default=c.css`
  :host {
    margin-top: var(--wui-spacing-3xs);
  }
  wui-separator {
    margin: var(--wui-spacing-m) calc(var(--wui-spacing-m) * -1) var(--wui-spacing-xs)
      calc(var(--wui-spacing-m) * -1);
    width: calc(100% + var(--wui-spacing-s) * 2);
  }
`},6927,[4951]);
__d(function(g,_r,_i,a,m,e,_d){Object.defineProperty(e,"__esModule",{value:!0}),e.W3mConnectingWcView=void 0;var t=_r(_d[0]),o=_r(_d[1]),n=_r(_d[2]),r=_r(_d[3]);_r(_d[4]),_r(_d[5]),_r(_d[6]),_r(_d[7]),_r(_d[8]),_r(_d[9]),_r(_d[10]);var i=this&&this.__decorate||function(t,o,n,r){var i,s=arguments.length,l=s<3?o:null===r?r=Object.getOwnPropertyDescriptor(o,n):r;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)l=Reflect.decorate(t,o,n,r);else for(var c=t.length-1;c>=0;c--)(i=t[c])&&(l=(s<3?i(l):s>3?i(o,n,l):i(o,n))||l);return s>3&&l&&Object.defineProperty(o,n,l),l};let s=e.W3mConnectingWcView=class extends t.LitElement{constructor(){super(),this.wallet=n.RouterController.state.data?.wallet,this.unsubscribe=[],this.platform=void 0,this.platforms=[],this.isSiwxEnabled=Boolean(n.OptionsController.state.siwx),this.remoteFeatures=n.OptionsController.state.remoteFeatures,this.determinePlatforms(),this.initializeConnection(),this.unsubscribe.push(n.OptionsController.subscribeKey('remoteFeatures',t=>this.remoteFeatures=t))}disconnectedCallback(){this.unsubscribe.forEach(t=>t())}render(){return t.html`
      ${this.headerTemplate()}
      <div>${this.platformTemplate()}</div>
      ${this.reownBrandingTemplate()}
    `}reownBrandingTemplate(){return this.remoteFeatures?.reownBranding?t.html`<wui-ux-by-reown></wui-ux-by-reown>`:null}async initializeConnection(t=!1){if('browser'!==this.platform&&(!n.OptionsController.state.manualWCControl||t))try{const{wcPairingExpiry:o,status:r}=n.ConnectionController.state;(t||n.OptionsController.state.enableEmbedded||n.CoreHelperUtil.isPairingExpired(o)||'connecting'===r)&&(await n.ConnectionController.connectWalletConnect(),this.isSiwxEnabled||n.ModalController.close())}catch(t){n.EventsController.sendEvent({type:'track',event:'CONNECT_ERROR',properties:{message:t?.message??'Unknown'}}),n.ConnectionController.setWcError(!0),n.SnackController.showError(t.message??'Connection error'),n.ConnectionController.resetWcConnection(),n.RouterController.goBack()}}determinePlatforms(){if(!this.wallet)return this.platforms.push('qrcode'),void(this.platform='qrcode');if(this.platform)return;const{mobile_link:t,desktop_link:o,webapp_link:r,injected:i,rdns:s}=this.wallet,l=i?.map(({injected_id:t})=>t).filter(Boolean),c=[...s?[s]:l??[]],p=!n.OptionsController.state.isUniversalProvider&&c.length,h=t,d=r,w=n.ConnectionController.checkInstalled(c),u=p&&w,f=o&&!n.CoreHelperUtil.isMobile();u&&!n.ChainController.state.noAdapters&&this.platforms.push('browser'),h&&this.platforms.push(n.CoreHelperUtil.isMobile()?'mobile':'qrcode'),d&&this.platforms.push('web'),f&&this.platforms.push('desktop'),u||!p||n.ChainController.state.noAdapters||this.platforms.push('unsupported'),this.platform=this.platforms[0]}platformTemplate(){switch(this.platform){case'browser':return t.html`<w3m-connecting-wc-browser></w3m-connecting-wc-browser>`;case'web':return t.html`<w3m-connecting-wc-web></w3m-connecting-wc-web>`;case'desktop':return t.html`
          <w3m-connecting-wc-desktop .onRetry=${()=>this.initializeConnection(!0)}>
          </w3m-connecting-wc-desktop>
        `;case'mobile':return t.html`
          <w3m-connecting-wc-mobile isMobile .onRetry=${()=>this.initializeConnection(!0)}>
          </w3m-connecting-wc-mobile>
        `;case'qrcode':return t.html`<w3m-connecting-wc-qrcode></w3m-connecting-wc-qrcode>`;default:return t.html`<w3m-connecting-wc-unsupported></w3m-connecting-wc-unsupported>`}}headerTemplate(){return this.platforms.length>1?t.html`
      <w3m-connecting-header
        .platforms=${this.platforms}
        .onSelectPlatfrom=${this.onSelectPlatform.bind(this)}
      >
      </w3m-connecting-header>
    `:null}async onSelectPlatform(t){const o=this.shadowRoot?.querySelector('div');o&&(await o.animate([{opacity:1},{opacity:0}],{duration:200,fill:'forwards',easing:'ease'}).finished,this.platform=t,o.animate([{opacity:0},{opacity:1}],{duration:200,fill:'forwards',easing:'ease'}))}};i([(0,o.state)()],s.prototype,"platform",void 0),i([(0,o.state)()],s.prototype,"platforms",void 0),i([(0,o.state)()],s.prototype,"isSiwxEnabled",void 0),i([(0,o.state)()],s.prototype,"remoteFeatures",void 0),e.W3mConnectingWcView=s=i([(0,r.customElement)('w3m-connecting-wc-view')],s)},6928,[4951,4960,4631,4948,6929,6933,6954,6955,6956,6997,6998]);
__d(function(g,_r,_i,a,m,e,_d){Object.defineProperty(e,"__esModule",{value:!0}),e.W3mConnectingHeader=void 0;var t=_r(_d[0]),o=_r(_d[1]),r=_r(_d[2]);_r(_d[3]),_r(_d[4]);var n=this&&this.__decorate||function(t,o,r,n){var l,s=arguments.length,i=s<3?o:null===n?n=Object.getOwnPropertyDescriptor(o,r):n;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)i=Reflect.decorate(t,o,r,n);else for(var c=t.length-1;c>=0;c--)(l=t[c])&&(i=(s<3?l(i):s>3?l(o,r,i):l(o,r))||i);return s>3&&i&&Object.defineProperty(o,r,i),i};let l=e.W3mConnectingHeader=class extends t.LitElement{constructor(){super(...arguments),this.platformTabs=[],this.unsubscribe=[],this.platforms=[],this.onSelectPlatfrom=void 0}disconnectCallback(){this.unsubscribe.forEach(t=>t())}render(){const o=this.generateTabs();return t.html`
      <wui-flex justifyContent="center" .padding=${['0','0','l','0']}>
        <wui-tabs .tabs=${o} .onTabChange=${this.onTabChange.bind(this)}></wui-tabs>
      </wui-flex>
    `}generateTabs(){const t=this.platforms.map(t=>'browser'===t?{label:'Browser',icon:'extension',platform:'browser'}:'mobile'===t?{label:'Mobile',icon:'mobile',platform:'mobile'}:'qrcode'===t?{label:'Mobile',icon:'mobile',platform:'qrcode'}:'web'===t?{label:'Webapp',icon:'browser',platform:'web'}:'desktop'===t?{label:'Desktop',icon:'desktop',platform:'desktop'}:{label:'Browser',icon:'extension',platform:'unsupported'});return this.platformTabs=t.map(({platform:t})=>t),t}onTabChange(t){const o=this.platformTabs[t];o&&this.onSelectPlatfrom?.(o)}};n([(0,o.property)({type:Array})],l.prototype,"platforms",void 0),n([(0,o.property)()],l.prototype,"onSelectPlatfrom",void 0),e.W3mConnectingHeader=l=n([(0,r.customElement)('w3m-connecting-header')],l)},6929,[4951,4960,4948,4971,6930]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0});var n=r(d[0]);Object.keys(n).forEach(function(t){"default"!==t&&"__esModule"!==t&&(t in e&&e[t]===n[t]||Object.defineProperty(e,t,{enumerable:!0,get:function(){return n[t]}}))})},6930,[6931]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.WuiTabs=void 0;var i=_r(_d[1]),s=_r(_d[2]);_r(_d[3]),_r(_d[4]);var o=_r(_d[5]),n=_r(_d[6]),r=t(_r(_d[7])),l=this&&this.__decorate||function(t,i,s,o){var n,r=arguments.length,l=r<3?i:null===o?o=Object.getOwnPropertyDescriptor(i,s):o;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)l=Reflect.decorate(t,i,s,o);else for(var h=t.length-1;h>=0;h--)(n=t[h])&&(l=(r<3?n(l):r>3?n(i,s,l):n(i,s))||l);return r>3&&l&&Object.defineProperty(i,s,l),l};let h=e.WuiTabs=class extends i.LitElement{constructor(){super(...arguments),this.tabs=[],this.onTabChange=()=>null,this.buttons=[],this.disabled=!1,this.localTabWidth='100px',this.activeTab=0,this.isDense=!1}render(){return this.isDense=this.tabs.length>3,this.style.cssText=`\n      --local-tab: ${this.activeTab};\n      --local-tab-width: ${this.localTabWidth};\n    `,this.dataset.type=this.isDense?'flex':'block',this.tabs.map((t,s)=>{const o=s===this.activeTab;return i.html`
        <button
          ?disabled=${this.disabled}
          @click=${()=>this.onTabClick(s)}
          data-active=${o}
          data-testid="tab-${t.label?.toLowerCase()}"
        >
          ${this.iconTemplate(t)}
          <wui-text variant="small-600" color="inherit"> ${t.label} </wui-text>
        </button>
      `})}firstUpdated(){this.shadowRoot&&this.isDense&&(this.buttons=[...this.shadowRoot.querySelectorAll('button')],setTimeout(()=>{this.animateTabs(0,!0)},0))}iconTemplate(t){return t.icon?i.html`<wui-icon size="xs" color="inherit" name=${t.icon}></wui-icon>`:null}onTabClick(t){this.buttons&&this.animateTabs(t,!1),this.activeTab=t,this.onTabChange(t)}animateTabs(t,i){const s=this.buttons[this.activeTab],o=this.buttons[t],n=s?.querySelector('wui-text'),r=o?.querySelector('wui-text'),l=o?.getBoundingClientRect(),h=r?.getBoundingClientRect();s&&n&&!i&&t!==this.activeTab&&(n.animate([{opacity:0}],{duration:50,easing:'ease',fill:'forwards'}),s.animate([{width:"34px"}],{duration:500,easing:'ease',fill:'forwards'})),o&&l&&h&&r&&(t!==this.activeTab||i)&&(this.localTabWidth=`${Math.round(l.width+h.width)+6}px`,o.animate([{width:`${l.width+h.width}px`}],{duration:i?0:500,fill:'forwards',easing:'ease'}),r.animate([{opacity:1}],{duration:i?0:125,delay:i?0:200,fill:'forwards',easing:'ease'}))}};h.styles=[o.resetStyles,o.elementStyles,r.default],l([(0,s.property)({type:Array})],h.prototype,"tabs",void 0),l([(0,s.property)()],h.prototype,"onTabChange",void 0),l([(0,s.property)({type:Array})],h.prototype,"buttons",void 0),l([(0,s.property)({type:Boolean})],h.prototype,"disabled",void 0),l([(0,s.property)()],h.prototype,"localTabWidth",void 0),l([(0,s.state)()],h.prototype,"activeTab",void 0),l([(0,s.state)()],h.prototype,"isDense",void 0),e.WuiTabs=h=l([(0,n.customElement)('wui-tabs')],h)},6931,[2,4951,4960,4976,4985,4950,4959,6932]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var t=r(d[0]);e.default=t.css`
  :host {
    display: inline-flex;
    background-color: var(--wui-color-gray-glass-002);
    border-radius: var(--wui-border-radius-3xl);
    padding: var(--wui-spacing-3xs);
    position: relative;
    height: 36px;
    min-height: 36px;
    overflow: hidden;
  }

  :host::before {
    content: '';
    position: absolute;
    pointer-events: none;
    top: 4px;
    left: 4px;
    display: block;
    width: var(--local-tab-width);
    height: 28px;
    border-radius: var(--wui-border-radius-3xl);
    background-color: var(--wui-color-gray-glass-002);
    box-shadow: inset 0 0 0 1px var(--wui-color-gray-glass-002);
    transform: translateX(calc(var(--local-tab) * var(--local-tab-width)));
    transition: transform var(--wui-ease-out-power-1) var(--wui-duration-md);
    will-change: background-color, opacity;
  }

  :host([data-type='flex'])::before {
    left: 3px;
    transform: translateX(calc((var(--local-tab) * 34px) + (var(--local-tab) * 4px)));
  }

  :host([data-type='flex']) {
    display: flex;
    padding: 0px 0px 0px 12px;
    gap: 4px;
  }

  :host([data-type='flex']) > button > wui-text {
    position: absolute;
    left: 18px;
    opacity: 0;
  }

  button[data-active='true'] > wui-icon,
  button[data-active='true'] > wui-text {
    color: var(--wui-color-fg-100);
  }

  button[data-active='false'] > wui-icon,
  button[data-active='false'] > wui-text {
    color: var(--wui-color-fg-200);
  }

  button[data-active='true']:disabled,
  button[data-active='false']:disabled {
    background-color: transparent;
    opacity: 0.5;
    cursor: not-allowed;
  }

  button[data-active='true']:disabled > wui-text {
    color: var(--wui-color-fg-200);
  }

  button[data-active='false']:disabled > wui-text {
    color: var(--wui-color-fg-300);
  }

  button > wui-icon,
  button > wui-text {
    pointer-events: none;
    transition: color var(--wui-e ase-out-power-1) var(--wui-duration-md);
    will-change: color;
  }

  button {
    width: var(--local-tab-width);
    transition: background-color var(--wui-ease-out-power-1) var(--wui-duration-md);
    will-change: background-color;
  }

  :host([data-type='flex']) > button {
    width: 34px;
    position: relative;
    display: flex;
    justify-content: flex-start;
  }

  button:hover:enabled,
  button:active:enabled {
    background-color: transparent !important;
  }

  button:hover:enabled > wui-icon,
  button:active:enabled > wui-icon {
    transition: all var(--wui-ease-out-power-1) var(--wui-duration-lg);
    color: var(--wui-color-fg-125);
  }

  button:hover:enabled > wui-text,
  button:active:enabled > wui-text {
    transition: all var(--wui-ease-out-power-1) var(--wui-duration-lg);
    color: var(--wui-color-fg-125);
  }

  button {
    border-radius: var(--wui-border-radius-3xl);
  }
`},6932,[4951]);
__d(function(g,_r,_i,a,m,e,_d){Object.defineProperty(e,"__esModule",{value:!0}),e.W3mConnectingWcBrowser=void 0;var n=_r(_d[0]),t=_r(_d[1]),o=_r(_d[2]),r=this&&this.__decorate||function(n,t,o,r){var c,s=arguments.length,i=s<3?t:null===r?r=Object.getOwnPropertyDescriptor(t,o):r;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)i=Reflect.decorate(n,t,o,r);else for(var l=n.length-1;l>=0;l--)(c=n[l])&&(i=(s<3?c(i):s>3?c(t,o,i):c(t,o))||i);return s>3&&i&&Object.defineProperty(t,o,i),i};let c=e.W3mConnectingWcBrowser=class extends o.W3mConnectingWidget{constructor(){if(super(),!this.wallet)throw new Error('w3m-connecting-wc-browser: No wallet provided');this.onConnect=this.onConnectProxy.bind(this),this.onAutoConnect=this.onConnectProxy.bind(this),n.EventsController.sendEvent({type:'track',event:'SELECT_WALLET',properties:{name:this.wallet.name,platform:'browser'}})}async onConnectProxy(){try{this.error=!1;const{connectors:t}=n.ConnectorController.state,o=t.find(n=>'ANNOUNCED'===n.type&&n.info?.rdns===this.wallet?.rdns||'INJECTED'===n.type||n.name===this.wallet?.name);if(!o)throw new Error('w3m-connecting-wc-browser: No connector found');await n.ConnectionController.connectExternal(o,o.chain),n.ModalController.close(),n.EventsController.sendEvent({type:'track',event:'CONNECT_SUCCESS',properties:{method:'browser',name:this.wallet?.name||'Unknown'}})}catch(t){n.EventsController.sendEvent({type:'track',event:'CONNECT_ERROR',properties:{message:t?.message??'Unknown'}}),this.error=!0}}};e.W3mConnectingWcBrowser=c=r([(0,t.customElement)('w3m-connecting-wc-browser')],c)},6933,[4631,4948,6934]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.W3mConnectingWidget=void 0;var o=_r(_d[1]),i=_r(_d[2]),r=_r(_d[3]),n=_r(_d[4]);_r(_d[5]),_r(_d[6]),_r(_d[7]),_r(_d[8]),_r(_d[9]),_r(_d[10]),_r(_d[11]),_r(_d[12]),_r(_d[13]);var s=t(_r(_d[14])),l=this&&this.__decorate||function(t,o,i,r){var n,s=arguments.length,l=s<3?o:null===r?r=Object.getOwnPropertyDescriptor(o,i):r;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)l=Reflect.decorate(t,o,i,r);else for(var c=t.length-1;c>=0;c--)(n=t[c])&&(l=(s<3?n(l):s>3?n(o,i,l):n(o,i))||l);return s>3&&l&&Object.defineProperty(o,i,l),l};class c extends o.LitElement{constructor(){super(),this.wallet=n.RouterController.state.data?.wallet,this.connector=n.RouterController.state.data?.connector,this.timeout=void 0,this.secondaryBtnIcon='refresh',this.onConnect=void 0,this.onRender=void 0,this.onAutoConnect=void 0,this.isWalletConnect=!0,this.unsubscribe=[],this.imageSrc=n.AssetUtil.getWalletImage(this.wallet)??n.AssetUtil.getConnectorImage(this.connector),this.name=this.wallet?.name??this.connector?.name??'Wallet',this.isRetrying=!1,this.uri=n.ConnectionController.state.wcUri,this.error=n.ConnectionController.state.wcError,this.ready=!1,this.showRetry=!1,this.secondaryBtnLabel='Try again',this.secondaryLabel='Accept connection request in the wallet',this.isLoading=!1,this.isMobile=!1,this.onRetry=void 0,this.unsubscribe.push(n.ConnectionController.subscribeKey('wcUri',t=>{this.uri=t,this.isRetrying&&this.onRetry&&(this.isRetrying=!1,this.onConnect?.())}),n.ConnectionController.subscribeKey('wcError',t=>this.error=t)),(n.CoreHelperUtil.isTelegram()||n.CoreHelperUtil.isSafari())&&n.CoreHelperUtil.isIos()&&n.ConnectionController.state.wcUri&&this.onConnect?.()}firstUpdated(){this.onAutoConnect?.(),this.showRetry=!this.onAutoConnect}disconnectedCallback(){this.unsubscribe.forEach(t=>t()),n.ConnectionController.setWcError(!1),clearTimeout(this.timeout)}render(){this.onRender?.(),this.onShowRetry();const t=this.error?'Connection can be declined if a previous request is still active':this.secondaryLabel;let i=`Continue in ${this.name}`;return this.error&&(i='Connection declined'),o.html`
      <wui-flex
        data-error=${(0,r.ifDefined)(this.error)}
        data-retry=${this.showRetry}
        flexDirection="column"
        alignItems="center"
        .padding=${['3xl','xl','xl','xl']}
        gap="xl"
      >
        <wui-flex justifyContent="center" alignItems="center">
          <wui-wallet-image size="lg" imageSrc=${(0,r.ifDefined)(this.imageSrc)}></wui-wallet-image>

          ${this.error?null:this.loaderTemplate()}

          <wui-icon-box
            backgroundColor="error-100"
            background="opaque"
            iconColor="error-100"
            icon="close"
            size="sm"
            border
            borderColor="wui-color-bg-125"
          ></wui-icon-box>
        </wui-flex>

        <wui-flex flexDirection="column" alignItems="center" gap="xs">
          <wui-text variant="paragraph-500" color=${this.error?'error-100':'fg-100'}>
            ${i}
          </wui-text>
          <wui-text align="center" variant="small-500" color="fg-200">${t}</wui-text>
        </wui-flex>

        ${this.secondaryBtnLabel?o.html`
              <wui-button
                variant="accent"
                size="md"
                ?disabled=${this.isRetrying||this.isLoading}
                @click=${this.onTryAgain.bind(this)}
                data-testid="w3m-connecting-widget-secondary-button"
              >
                <wui-icon color="inherit" slot="iconLeft" name=${this.secondaryBtnIcon}></wui-icon>
                ${this.secondaryBtnLabel}
              </wui-button>
            `:null}
      </wui-flex>

      ${this.isWalletConnect?o.html`
            <wui-flex .padding=${['0','xl','xl','xl']} justifyContent="center">
              <wui-link @click=${this.onCopyUri} color="fg-200" data-testid="wui-link-copy">
                <wui-icon size="xs" color="fg-200" slot="iconLeft" name="copy"></wui-icon>
                Copy link
              </wui-link>
            </wui-flex>
          `:null}

      <w3m-mobile-download-links .wallet=${this.wallet}></w3m-mobile-download-links>
    `}onShowRetry(){if(this.error&&!this.showRetry){this.showRetry=!0;const t=this.shadowRoot?.querySelector('wui-button');t?.animate([{opacity:0},{opacity:1}],{fill:'forwards',easing:'ease'})}}onTryAgain(){n.ConnectionController.setWcError(!1),this.onRetry?(this.isRetrying=!0,this.onRetry?.()):this.onConnect?.()}loaderTemplate(){const t=n.ThemeController.state.themeVariables['--w3m-border-radius-master'],i=t?parseInt(t.replace('px',''),10):4;return o.html`<wui-loading-thumbnail radius=${9*i}></wui-loading-thumbnail>`}onCopyUri(){try{this.uri&&(n.CoreHelperUtil.copyToClopboard(this.uri),n.SnackController.showSuccess('Link copied'))}catch{n.SnackController.showError('Failed to copy')}}}e.W3mConnectingWidget=c,c.styles=s.default,l([(0,i.state)()],c.prototype,"isRetrying",void 0),l([(0,i.state)()],c.prototype,"uri",void 0),l([(0,i.state)()],c.prototype,"error",void 0),l([(0,i.state)()],c.prototype,"ready",void 0),l([(0,i.state)()],c.prototype,"showRetry",void 0),l([(0,i.state)()],c.prototype,"secondaryBtnLabel",void 0),l([(0,i.state)()],c.prototype,"secondaryLabel",void 0),l([(0,i.state)()],c.prototype,"isLoading",void 0),l([(0,i.property)({type:Boolean})],c.prototype,"isMobile",void 0),l([(0,i.property)()],c.prototype,"onRetry",void 0)},6934,[2,4951,4960,4974,4631,6935,4971,4997,6938,6939,6942,4998,6945,6946,6953]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0});var n=r(d[0]);Object.keys(n).forEach(function(t){"default"!==t&&"__esModule"!==t&&(t in e&&e[t]===n[t]||Object.defineProperty(e,t,{enumerable:!0,get:function(){return n[t]}}))})},6935,[6936]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.WuiButton=void 0;var o=_r(_d[1]),i=_r(_d[2]);_r(_d[3]),_r(_d[4]);var s=_r(_d[5]),r=_r(_d[6]),n=t(_r(_d[7])),l=this&&this.__decorate||function(t,o,i,s){var r,n=arguments.length,l=n<3?o:null===s?s=Object.getOwnPropertyDescriptor(o,i):s;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)l=Reflect.decorate(t,o,i,s);else for(var d=t.length-1;d>=0;d--)(r=t[d])&&(l=(n<3?r(l):n>3?r(o,i,l):r(o,i))||l);return n>3&&l&&Object.defineProperty(o,i,l),l};const d={main:'inverse-100',inverse:'inverse-000',accent:'accent-100','accent-error':'error-100','accent-success':'success-100',neutral:'fg-100',disabled:'gray-glass-020'},h={lg:'paragraph-600',md:'small-600'},c={lg:'md',md:'md'};let p=e.WuiButton=class extends o.LitElement{constructor(){super(...arguments),this.size='lg',this.disabled=!1,this.fullWidth=!1,this.loading=!1,this.variant='main',this.hasIconLeft=!1,this.hasIconRight=!1,this.borderRadius='m'}render(){this.style.cssText=`\n    --local-width: ${this.fullWidth?'100%':'auto'};\n    --local-opacity-100: ${this.loading?0:1};\n    --local-opacity-000: ${this.loading?1:0};\n    --local-border-radius: var(--wui-border-radius-${this.borderRadius});\n    `;const t=this.textVariant??h[this.size];return o.html`
      <button
        data-variant=${this.variant}
        data-icon-left=${this.hasIconLeft}
        data-icon-right=${this.hasIconRight}
        data-size=${this.size}
        ?disabled=${this.disabled}
      >
        ${this.loadingTemplate()}
        <slot name="iconLeft" @slotchange=${()=>this.handleSlotLeftChange()}></slot>
        <wui-text variant=${t} color="inherit">
          <slot></slot>
        </wui-text>
        <slot name="iconRight" @slotchange=${()=>this.handleSlotRightChange()}></slot>
      </button>
    `}handleSlotLeftChange(){this.hasIconLeft=!0}handleSlotRightChange(){this.hasIconRight=!0}loadingTemplate(){if(this.loading){const t=c[this.size],i=this.disabled?d.disabled:d[this.variant];return o.html`<wui-loading-spinner color=${i} size=${t}></wui-loading-spinner>`}return o.html``}};p.styles=[s.resetStyles,s.elementStyles,n.default],l([(0,i.property)()],p.prototype,"size",void 0),l([(0,i.property)({type:Boolean})],p.prototype,"disabled",void 0),l([(0,i.property)({type:Boolean})],p.prototype,"fullWidth",void 0),l([(0,i.property)({type:Boolean})],p.prototype,"loading",void 0),l([(0,i.property)()],p.prototype,"variant",void 0),l([(0,i.property)({type:Boolean})],p.prototype,"hasIconLeft",void 0),l([(0,i.property)({type:Boolean})],p.prototype,"hasIconRight",void 0),l([(0,i.property)()],p.prototype,"borderRadius",void 0),l([(0,i.property)()],p.prototype,"textVariant",void 0),e.WuiButton=p=l([(0,r.customElement)('wui-button')],p)},6936,[2,4951,4960,4995,4985,4950,4959,6937]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var o=r(d[0]);e.default=o.css`
  :host {
    width: var(--local-width);
    position: relative;
  }

  button {
    border: none;
    border-radius: var(--local-border-radius);
    width: var(--local-width);
    white-space: nowrap;
  }

  /* -- Sizes --------------------------------------------------- */
  button[data-size='md'] {
    padding: 8.2px var(--wui-spacing-l) 9px var(--wui-spacing-l);
    height: 36px;
  }

  button[data-size='md'][data-icon-left='true'][data-icon-right='false'] {
    padding: 8.2px var(--wui-spacing-l) 9px var(--wui-spacing-s);
  }

  button[data-size='md'][data-icon-right='true'][data-icon-left='false'] {
    padding: 8.2px var(--wui-spacing-s) 9px var(--wui-spacing-l);
  }

  button[data-size='lg'] {
    padding: var(--wui-spacing-m) var(--wui-spacing-2l);
    height: 48px;
  }

  /* -- Variants --------------------------------------------------------- */
  button[data-variant='main'] {
    background-color: var(--wui-color-accent-100);
    color: var(--wui-color-inverse-100);
    border: none;
    box-shadow: inset 0 0 0 1px var(--wui-color-gray-glass-010);
  }

  button[data-variant='inverse'] {
    background-color: var(--wui-color-inverse-100);
    color: var(--wui-color-inverse-000);
    border: none;
    box-shadow: inset 0 0 0 1px var(--wui-color-gray-glass-010);
  }

  button[data-variant='accent'] {
    background-color: var(--wui-color-accent-glass-010);
    color: var(--wui-color-accent-100);
    border: none;
    box-shadow: inset 0 0 0 1px var(--wui-color-gray-glass-005);
  }

  button[data-variant='accent-error'] {
    background: var(--wui-color-error-glass-015);
    color: var(--wui-color-error-100);
    border: none;
    box-shadow: inset 0 0 0 1px var(--wui-color-error-glass-010);
  }

  button[data-variant='accent-success'] {
    background: var(--wui-color-success-glass-015);
    color: var(--wui-color-success-100);
    border: none;
    box-shadow: inset 0 0 0 1px var(--wui-color-success-glass-010);
  }

  button[data-variant='neutral'] {
    background: transparent;
    color: var(--wui-color-fg-100);
    border: none;
    box-shadow: inset 0 0 0 1px var(--wui-color-gray-glass-005);
  }

  /* -- Focus states --------------------------------------------------- */
  button[data-variant='main']:focus-visible:enabled {
    background-color: var(--wui-color-accent-090);
    box-shadow:
      inset 0 0 0 1px var(--wui-color-accent-100),
      0 0 0 4px var(--wui-color-accent-glass-020);
  }
  button[data-variant='inverse']:focus-visible:enabled {
    background-color: var(--wui-color-inverse-100);
    box-shadow:
      inset 0 0 0 1px var(--wui-color-gray-glass-010),
      0 0 0 4px var(--wui-color-accent-glass-020);
  }
  button[data-variant='accent']:focus-visible:enabled {
    background-color: var(--wui-color-accent-glass-010);
    box-shadow:
      inset 0 0 0 1px var(--wui-color-accent-100),
      0 0 0 4px var(--wui-color-accent-glass-020);
  }
  button[data-variant='accent-error']:focus-visible:enabled {
    background: var(--wui-color-error-glass-015);
    box-shadow:
      inset 0 0 0 1px var(--wui-color-error-100),
      0 0 0 4px var(--wui-color-error-glass-020);
  }
  button[data-variant='accent-success']:focus-visible:enabled {
    background: var(--wui-color-success-glass-015);
    box-shadow:
      inset 0 0 0 1px var(--wui-color-success-100),
      0 0 0 4px var(--wui-color-success-glass-020);
  }
  button[data-variant='neutral']:focus-visible:enabled {
    background: var(--wui-color-gray-glass-005);
    box-shadow:
      inset 0 0 0 1px var(--wui-color-gray-glass-010),
      0 0 0 4px var(--wui-color-gray-glass-002);
  }

  /* -- Hover & Active states ----------------------------------------------------------- */
  @media (hover: hover) and (pointer: fine) {
    button[data-variant='main']:hover:enabled {
      background-color: var(--wui-color-accent-090);
    }

    button[data-variant='main']:active:enabled {
      background-color: var(--wui-color-accent-080);
    }

    button[data-variant='accent']:hover:enabled {
      background-color: var(--wui-color-accent-glass-015);
    }

    button[data-variant='accent']:active:enabled {
      background-color: var(--wui-color-accent-glass-020);
    }

    button[data-variant='accent-error']:hover:enabled {
      background: var(--wui-color-error-glass-020);
      color: var(--wui-color-error-100);
    }

    button[data-variant='accent-error']:active:enabled {
      background: var(--wui-color-error-glass-030);
      color: var(--wui-color-error-100);
    }

    button[data-variant='accent-success']:hover:enabled {
      background: var(--wui-color-success-glass-020);
      color: var(--wui-color-success-100);
    }

    button[data-variant='accent-success']:active:enabled {
      background: var(--wui-color-success-glass-030);
      color: var(--wui-color-success-100);
    }

    button[data-variant='neutral']:hover:enabled {
      background: var(--wui-color-gray-glass-002);
    }

    button[data-variant='neutral']:active:enabled {
      background: var(--wui-color-gray-glass-005);
    }

    button[data-size='lg'][data-icon-left='true'][data-icon-right='false'] {
      padding-left: var(--wui-spacing-m);
    }

    button[data-size='lg'][data-icon-right='true'][data-icon-left='false'] {
      padding-right: var(--wui-spacing-m);
    }
  }

  /* -- Disabled state --------------------------------------------------- */
  button:disabled {
    background-color: var(--wui-color-gray-glass-002);
    box-shadow: inset 0 0 0 1px var(--wui-color-gray-glass-002);
    color: var(--wui-color-gray-glass-020);
    cursor: not-allowed;
  }

  button > wui-text {
    transition: opacity var(--wui-ease-out-power-1) var(--wui-duration-md);
    will-change: opacity;
    opacity: var(--local-opacity-100);
  }

  ::slotted(*) {
    transition: opacity var(--wui-ease-out-power-1) var(--wui-duration-md);
    will-change: opacity;
    opacity: var(--local-opacity-100);
  }

  wui-loading-spinner {
    position: absolute;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    opacity: var(--local-opacity-000);
  }
`},6937,[4951]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0});var n=r(d[0]);Object.keys(n).forEach(function(t){"default"!==t&&"__esModule"!==t&&(t in e&&e[t]===n[t]||Object.defineProperty(e,t,{enumerable:!0,get:function(){return n[t]}}))})},6938,[4989]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0});var n=r(d[0]);Object.keys(n).forEach(function(t){"default"!==t&&"__esModule"!==t&&(t in e&&e[t]===n[t]||Object.defineProperty(e,t,{enumerable:!0,get:function(){return n[t]}}))})},6939,[6940]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.WuiLink=void 0;var o=_r(_d[1]),i=_r(_d[2]),r=_r(_d[3]);_r(_d[4]);var l=_r(_d[5]),n=_r(_d[6]),s=t(_r(_d[7])),d=this&&this.__decorate||function(t,o,i,r){var l,n=arguments.length,s=n<3?o:null===r?r=Object.getOwnPropertyDescriptor(o,i):r;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)s=Reflect.decorate(t,o,i,r);else for(var d=t.length-1;d>=0;d--)(l=t[d])&&(s=(n<3?l(s):n>3?l(o,i,s):l(o,i))||s);return n>3&&s&&Object.defineProperty(o,i,s),s};let c=e.WuiLink=class extends o.LitElement{constructor(){super(...arguments),this.tabIdx=void 0,this.disabled=!1,this.color='inherit'}render(){return o.html`
      <button ?disabled=${this.disabled} tabindex=${(0,r.ifDefined)(this.tabIdx)}>
        <slot name="iconLeft"></slot>
        <wui-text variant="small-600" color=${this.color}>
          <slot></slot>
        </wui-text>
        <slot name="iconRight"></slot>
      </button>
    `}};c.styles=[l.resetStyles,l.elementStyles,s.default],d([(0,i.property)()],c.prototype,"tabIdx",void 0),d([(0,i.property)({type:Boolean})],c.prototype,"disabled",void 0),d([(0,i.property)()],c.prototype,"color",void 0),e.WuiLink=c=d([(0,n.customElement)('wui-link')],c)},6940,[2,4951,4960,4974,4985,4950,4959,6941]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var o=r(d[0]);e.default=o.css`
  button {
    padding: var(--wui-spacing-4xs) var(--wui-spacing-xxs);
    border-radius: var(--wui-border-radius-3xs);
    background-color: transparent;
    color: var(--wui-color-accent-100);
  }

  button:disabled {
    background-color: transparent;
    color: var(--wui-color-gray-glass-015);
  }

  button:hover {
    background-color: var(--wui-color-gray-glass-005);
  }
`},6941,[4951]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0});var n=r(d[0]);Object.keys(n).forEach(function(t){"default"!==t&&"__esModule"!==t&&(t in e&&e[t]===n[t]||Object.defineProperty(e,t,{enumerable:!0,get:function(){return n[t]}}))})},6942,[6943]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.WuiLoadingThumbnail=void 0;var r=_r(_d[1]),i=_r(_d[2]),o=_r(_d[3]),s=_r(_d[4]),n=t(_r(_d[5])),d=this&&this.__decorate||function(t,r,i,o){var s,n=arguments.length,d=n<3?r:null===o?o=Object.getOwnPropertyDescriptor(r,i):o;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)d=Reflect.decorate(t,r,i,o);else for(var u=t.length-1;u>=0;u--)(s=t[u])&&(d=(n<3?s(d):n>3?s(r,i,d):s(r,i))||d);return n>3&&d&&Object.defineProperty(r,i,d),d};let u=e.WuiLoadingThumbnail=class extends r.LitElement{constructor(){super(...arguments),this.radius=36}render(){return this.svgLoaderTemplate()}svgLoaderTemplate(){const t=this.radius>50?50:this.radius,i=36-t,o=116+i,s=245+i,n=360+1.75*i;return r.html`
      <svg viewBox="0 0 110 110" width="110" height="110">
        <rect
          x="2"
          y="2"
          width="106"
          height="106"
          rx=${t}
          stroke-dasharray="${o} ${s}"
          stroke-dashoffset=${n}
        />
      </svg>
    `}};u.styles=[o.resetStyles,n.default],d([(0,i.property)({type:Number})],u.prototype,"radius",void 0),e.WuiLoadingThumbnail=u=d([(0,s.customElement)('wui-loading-thumbnail')],u)},6943,[2,4951,4960,4950,4959,6944]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var o=r(d[0]);e.default=o.css`
  :host {
    display: block;
    width: var(--wui-box-size-md);
    height: var(--wui-box-size-md);
  }

  svg {
    width: var(--wui-box-size-md);
    height: var(--wui-box-size-md);
  }

  rect {
    fill: none;
    stroke: var(--wui-color-accent-100);
    stroke-width: 4px;
    stroke-linecap: round;
    animation: dash 1s linear infinite;
  }

  @keyframes dash {
    to {
      stroke-dashoffset: 0px;
    }
  }
`},6944,[4951]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0});var n=r(d[0]);Object.keys(n).forEach(function(t){"default"!==t&&"__esModule"!==t&&(t in e&&e[t]===n[t]||Object.defineProperty(e,t,{enumerable:!0,get:function(){return n[t]}}))})},6945,[6913]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.W3mMobileDownloadLinks=void 0;var l=_r(_d[1]),o=_r(_d[2]),n=_r(_d[3]),i=_r(_d[4]);_r(_d[5]);var r=t(_r(_d[6])),s=this&&this.__decorate||function(t,l,o,n){var i,r=arguments.length,s=r<3?l:null===n?n=Object.getOwnPropertyDescriptor(l,o):n;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)s=Reflect.decorate(t,l,o,n);else for(var c=t.length-1;c>=0;c--)(i=t[c])&&(s=(r<3?i(s):r>3?i(l,o,s):i(l,o))||s);return r>3&&s&&Object.defineProperty(l,o,s),s};let c=e.W3mMobileDownloadLinks=class extends l.LitElement{constructor(){super(...arguments),this.wallet=void 0}render(){if(!this.wallet)return this.style.display='none',null;const{name:t,app_store:o,play_store:r,chrome_store:s,homepage:c}=this.wallet,p=n.CoreHelperUtil.isMobile(),u=n.CoreHelperUtil.isIos(),h=n.CoreHelperUtil.isAndroid(),b=[o,r,c,s].filter(Boolean).length>1,d=i.UiHelperUtil.getTruncateString({string:t,charsStart:12,charsEnd:0,truncate:'end'});return b&&!p?l.html`
        <wui-cta-button
          label=${`Don't have ${d}?`}
          buttonLabel="Get"
          @click=${()=>n.RouterController.push('Downloads',{wallet:this.wallet})}
        ></wui-cta-button>
      `:!b&&c?l.html`
        <wui-cta-button
          label=${`Don't have ${d}?`}
          buttonLabel="Get"
          @click=${this.onHomePage.bind(this)}
        ></wui-cta-button>
      `:o&&u?l.html`
        <wui-cta-button
          label=${`Don't have ${d}?`}
          buttonLabel="Get"
          @click=${this.onAppStore.bind(this)}
        ></wui-cta-button>
      `:r&&h?l.html`
        <wui-cta-button
          label=${`Don't have ${d}?`}
          buttonLabel="Get"
          @click=${this.onPlayStore.bind(this)}
        ></wui-cta-button>
      `:(this.style.display='none',null)}onAppStore(){this.wallet?.app_store&&n.CoreHelperUtil.openHref(this.wallet.app_store,'_blank')}onPlayStore(){this.wallet?.play_store&&n.CoreHelperUtil.openHref(this.wallet.play_store,'_blank')}onHomePage(){this.wallet?.homepage&&n.CoreHelperUtil.openHref(this.wallet.homepage,'_blank')}};c.styles=[r.default],s([(0,o.property)({type:Object})],c.prototype,"wallet",void 0),e.W3mMobileDownloadLinks=c=s([(0,i.customElement)('w3m-mobile-download-links')],c)},6946,[2,4951,4960,4631,4948,6947,6952]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0});var n=r(d[0]);Object.keys(n).forEach(function(t){"default"!==t&&"__esModule"!==t&&(t in e&&e[t]===n[t]||Object.defineProperty(e,t,{enumerable:!0,get:function(){return n[t]}}))})},6947,[6948]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.WuiCtaButton=void 0;var o=_r(_d[1]),r=_r(_d[2]);_r(_d[3]),_r(_d[4]),_r(_d[5]);var i=_r(_d[6]),n=_r(_d[7]),l=t(_r(_d[8])),u=this&&this.__decorate||function(t,o,r,i){var n,l=arguments.length,u=l<3?o:null===i?i=Object.getOwnPropertyDescriptor(o,r):i;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)u=Reflect.decorate(t,o,r,i);else for(var s=t.length-1;s>=0;s--)(n=t[s])&&(u=(l<3?n(u):l>3?n(o,r,u):n(o,r))||u);return l>3&&u&&Object.defineProperty(o,r,u),u};let s=e.WuiCtaButton=class extends o.LitElement{constructor(){super(...arguments),this.disabled=!1,this.label='',this.buttonLabel=''}render(){return o.html`
      <wui-flex
        justifyContent="space-between"
        alignItems="center"
        .padding=${['1xs','2l','1xs','2l']}
      >
        <wui-text variant="paragraph-500" color="fg-200">${this.label}</wui-text>
        <wui-chip-button size="sm" variant="shade" text=${this.buttonLabel} icon="chevronRight">
        </wui-chip-button>
      </wui-flex>
    `}};s.styles=[i.resetStyles,i.elementStyles,l.default],u([(0,r.property)({type:Boolean})],s.prototype,"disabled",void 0),u([(0,r.property)()],s.prototype,"label",void 0),u([(0,r.property)()],s.prototype,"buttonLabel",void 0),e.WuiCtaButton=s=u([(0,n.customElement)('wui-cta-button')],s)},6948,[2,4951,4960,4985,6949,4972,4950,4959,6951]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.WuiChipButton=void 0;var i=_r(_d[1]),r=_r(_d[2]);_r(_d[3]),_r(_d[4]),_r(_d[5]);var o=_r(_d[6]),n=_r(_d[7]),s=t(_r(_d[8])),p=this&&this.__decorate||function(t,i,r,o){var n,s=arguments.length,p=s<3?i:null===o?o=Object.getOwnPropertyDescriptor(i,r):o;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)p=Reflect.decorate(t,i,r,o);else for(var c=t.length-1;c>=0;c--)(n=t[c])&&(p=(s<3?n(p):s>3?n(i,r,p):n(i,r))||p);return s>3&&p&&Object.defineProperty(i,r,p),p};let c=e.WuiChipButton=class extends i.LitElement{constructor(){super(...arguments),this.variant='accent',this.imageSrc='',this.disabled=!1,this.icon='externalLink',this.size='md',this.text=''}render(){const t='sm'===this.size?'small-600':'paragraph-600';return i.html`
      <button
        class=${this.disabled?'disabled':''}
        data-variant=${this.variant}
        data-size=${this.size}
      >
        ${this.imageSrc?i.html`<wui-image src=${this.imageSrc}></wui-image>`:null}
        <wui-text variant=${t} color="inherit"> ${this.text} </wui-text>
        <wui-icon name=${this.icon} color="inherit" size="inherit"></wui-icon>
      </button>
    `}};c.styles=[o.resetStyles,o.elementStyles,s.default],p([(0,r.property)()],c.prototype,"variant",void 0),p([(0,r.property)()],c.prototype,"imageSrc",void 0),p([(0,r.property)({type:Boolean})],c.prototype,"disabled",void 0),p([(0,r.property)()],c.prototype,"icon",void 0),p([(0,r.property)()],c.prototype,"size",void 0),p([(0,r.property)()],c.prototype,"text",void 0),e.WuiChipButton=c=p([(0,n.customElement)('wui-chip-button')],c)},6949,[2,4951,4960,4976,4991,4985,4950,4959,6950]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var o=r(d[0]);e.default=o.css`
  button {
    border: none;
    border-radius: var(--wui-border-radius-3xl);
  }

  button[data-variant='main'] {
    background-color: var(--wui-color-accent-100);
    color: var(--wui-color-inverse-100);
    box-shadow: inset 0 0 0 1px var(--wui-color-gray-glass-010);
  }

  button[data-variant='accent'] {
    background-color: var(--wui-color-accent-glass-010);
    color: var(--wui-color-accent-100);
    box-shadow: inset 0 0 0 1px var(--wui-color-gray-glass-005);
  }

  button[data-variant='gray'] {
    background-color: transparent;
    color: var(--wui-color-fg-200);
    box-shadow: inset 0 0 0 1px var(--wui-color-gray-glass-010);
  }

  button[data-variant='shade'] {
    background-color: transparent;
    color: var(--wui-color-accent-100);
    box-shadow: inset 0 0 0 1px var(--wui-color-gray-glass-010);
  }

  button[data-size='sm'] {
    height: 32px;
    padding: 0 var(--wui-spacing-s);
  }

  button[data-size='md'] {
    height: 40px;
    padding: 0 var(--wui-spacing-l);
  }

  button[data-size='sm'] > wui-image {
    width: 16px;
    height: 16px;
  }

  button[data-size='md'] > wui-image {
    width: 24px;
    height: 24px;
  }

  button[data-size='sm'] > wui-icon {
    width: 12px;
    height: 12px;
  }

  button[data-size='md'] > wui-icon {
    width: 14px;
    height: 14px;
  }

  wui-image {
    border-radius: var(--wui-border-radius-3xl);
    overflow: hidden;
  }

  button.disabled > wui-icon,
  button.disabled > wui-image {
    filter: grayscale(1);
  }

  button[data-variant='main'] > wui-image {
    box-shadow: inset 0 0 0 1px var(--wui-color-accent-090);
  }

  button[data-variant='shade'] > wui-image,
  button[data-variant='gray'] > wui-image {
    box-shadow: inset 0 0 0 1px var(--wui-color-gray-glass-010);
  }

  @media (hover: hover) and (pointer: fine) {
    button[data-variant='main']:focus-visible {
      background-color: var(--wui-color-accent-090);
    }

    button[data-variant='main']:hover:enabled {
      background-color: var(--wui-color-accent-090);
    }

    button[data-variant='main']:active:enabled {
      background-color: var(--wui-color-accent-080);
    }

    button[data-variant='accent']:hover:enabled {
      background-color: var(--wui-color-accent-glass-015);
    }

    button[data-variant='accent']:active:enabled {
      background-color: var(--wui-color-accent-glass-020);
    }

    button[data-variant='shade']:focus-visible,
    button[data-variant='gray']:focus-visible,
    button[data-variant='shade']:hover,
    button[data-variant='gray']:hover {
      background-color: var(--wui-color-gray-glass-002);
    }

    button[data-variant='gray']:active,
    button[data-variant='shade']:active {
      background-color: var(--wui-color-gray-glass-005);
    }
  }

  button.disabled {
    color: var(--wui-color-gray-glass-020);
    background-color: var(--wui-color-gray-glass-002);
    box-shadow: inset 0 0 0 1px var(--wui-color-gray-glass-002);
    pointer-events: none;
  }
`},6950,[4951]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var o=r(d[0]);e.default=o.css`
  wui-flex {
    width: 100%;
    background-color: var(--wui-color-gray-glass-002);
    border-radius: var(--wui-border-radius-xs);
  }
`},6951,[4951]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var l=r(d[0]);e.default=l.css`
  :host {
    display: block;
    padding: 0 var(--wui-spacing-xl) var(--wui-spacing-xl);
  }
`},6952,[4951]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var t=r(d[0]);e.default=t.css`
  @keyframes shake {
    0% {
      transform: translateX(0);
    }
    25% {
      transform: translateX(3px);
    }
    50% {
      transform: translateX(-3px);
    }
    75% {
      transform: translateX(3px);
    }
    100% {
      transform: translateX(0);
    }
  }

  wui-flex:first-child:not(:only-child) {
    position: relative;
  }

  wui-loading-thumbnail {
    position: absolute;
  }

  wui-icon-box {
    position: absolute;
    right: calc(var(--wui-spacing-3xs) * -1);
    bottom: calc(var(--wui-spacing-3xs) * -1);
    opacity: 0;
    transform: scale(0.5);
    transition-property: opacity, transform;
    transition-duration: var(--wui-duration-lg);
    transition-timing-function: var(--wui-ease-out-power-2);
    will-change: opacity, transform;
  }

  wui-text[align='center'] {
    width: 100%;
    padding: 0px var(--wui-spacing-l);
  }

  [data-error='true'] wui-icon-box {
    opacity: 1;
    transform: scale(1);
  }

  [data-error='true'] > wui-flex:first-child {
    animation: shake 250ms cubic-bezier(0.36, 0.07, 0.19, 0.97) both;
  }

  [data-retry='false'] wui-link {
    display: none;
  }

  [data-retry='true'] wui-link {
    display: block;
    opacity: 1;
  }
`},6953,[4951]);
__d(function(g,_r,_i,a,m,e,_d){Object.defineProperty(e,"__esModule",{value:!0}),e.W3mConnectingWcDesktop=void 0;var t=_r(_d[0]),n=_r(_d[1]),o=_r(_d[2]),r=this&&this.__decorate||function(t,n,o,r){var i,c=arguments.length,s=c<3?n:null===r?r=Object.getOwnPropertyDescriptor(n,o):r;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)s=Reflect.decorate(t,n,o,r);else for(var l=t.length-1;l>=0;l--)(i=t[l])&&(s=(c<3?i(s):c>3?i(n,o,s):i(n,o))||s);return c>3&&s&&Object.defineProperty(n,o,s),s};let i=e.W3mConnectingWcDesktop=class extends o.W3mConnectingWidget{constructor(){if(super(),!this.wallet)throw new Error('w3m-connecting-wc-desktop: No wallet provided');this.onConnect=this.onConnectProxy.bind(this),this.onRender=this.onRenderProxy.bind(this),t.EventsController.sendEvent({type:'track',event:'SELECT_WALLET',properties:{name:this.wallet.name,platform:'desktop'}})}onRenderProxy(){!this.ready&&this.uri&&(this.ready=!0,this.onConnect?.())}onConnectProxy(){if(this.wallet?.desktop_link&&this.uri)try{this.error=!1;const{desktop_link:n,name:o}=this.wallet,{redirect:r,href:i}=t.CoreHelperUtil.formatNativeUrl(n,this.uri);t.ConnectionController.setWcLinking({name:o,href:i}),t.ConnectionController.setRecentWallet(this.wallet),t.CoreHelperUtil.openHref(r,'_blank')}catch{this.error=!0}}};e.W3mConnectingWcDesktop=i=r([(0,n.customElement)('w3m-connecting-wc-desktop')],i)},6954,[4631,4948,6934]);
__d(function(g,_r,_i,a,m,_e,_d){Object.defineProperty(_e,"__esModule",{value:!0}),_e.W3mConnectingWcMobile=void 0;var e=_r(_d[0]),t=_r(_d[1]),i=_r(_d[2]),n=_r(_d[3]),r=this&&this.__decorate||function(e,t,i,n){var r,o=arguments.length,s=o<3?t:null===n?n=Object.getOwnPropertyDescriptor(t,i):n;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)s=Reflect.decorate(e,t,i,n);else for(var l=e.length-1;l>=0;l--)(r=e[l])&&(s=(o<3?r(s):o>3?r(t,i,s):r(t,i))||s);return o>3&&s&&Object.defineProperty(t,i,s),s};let o=_e.W3mConnectingWcMobile=class extends n.W3mConnectingWidget{constructor(){if(super(),this.btnLabelTimeout=void 0,this.redirectDeeplink=void 0,this.redirectUniversalLink=void 0,this.target=void 0,this.preferUniversalLinks=t.OptionsController.state.experimental_preferUniversalLinks,this.isLoading=!0,this.onConnect=()=>{if(this.wallet?.mobile_link&&this.uri)try{this.error=!1;const{mobile_link:e,link_mode:i,name:n}=this.wallet,{redirect:r,redirectUniversalLink:o,href:s}=t.CoreHelperUtil.formatNativeUrl(e,this.uri,i);this.redirectDeeplink=r,this.redirectUniversalLink=o,this.target=t.CoreHelperUtil.isIframe()?'_top':'_self',t.ConnectionController.setWcLinking({name:n,href:s}),t.ConnectionController.setRecentWallet(this.wallet),this.preferUniversalLinks&&this.redirectUniversalLink?t.CoreHelperUtil.openHref(this.redirectUniversalLink,this.target):t.CoreHelperUtil.openHref(this.redirectDeeplink,this.target)}catch(e){t.EventsController.sendEvent({type:'track',event:'CONNECT_PROXY_ERROR',properties:{message:e instanceof Error?e.message:'Error parsing the deeplink',uri:this.uri,mobile_link:this.wallet.mobile_link,name:this.wallet.name}}),this.error=!0}},!this.wallet)throw new Error('w3m-connecting-wc-mobile: No wallet provided');this.secondaryBtnLabel='Open',this.secondaryLabel=t.ConstantsUtil.CONNECT_LABELS.MOBILE,this.secondaryBtnIcon='externalLink',this.onHandleURI(),this.unsubscribe.push(t.ConnectionController.subscribeKey('wcUri',()=>{this.onHandleURI()})),t.EventsController.sendEvent({type:'track',event:'SELECT_WALLET',properties:{name:this.wallet.name,platform:'mobile'}})}disconnectedCallback(){super.disconnectedCallback(),clearTimeout(this.btnLabelTimeout)}onHandleURI(){this.isLoading=!this.uri,!this.ready&&this.uri&&(this.ready=!0,this.onConnect?.())}onTryAgain(){t.ConnectionController.setWcError(!1),this.onConnect?.()}};r([(0,e.state)()],o.prototype,"redirectDeeplink",void 0),r([(0,e.state)()],o.prototype,"redirectUniversalLink",void 0),r([(0,e.state)()],o.prototype,"target",void 0),r([(0,e.state)()],o.prototype,"preferUniversalLinks",void 0),r([(0,e.state)()],o.prototype,"isLoading",void 0),_e.W3mConnectingWcMobile=o=r([(0,i.customElement)('w3m-connecting-wc-mobile')],o)},6955,[4960,4631,4948,6934]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.W3mConnectingWcQrcode=void 0;var i=_r(_d[1]),o=_r(_d[2]),n=_r(_d[3]),r=_r(_d[4]);_r(_d[5]),_r(_d[6]),_r(_d[7]),_r(_d[8]),_r(_d[9]),_r(_d[10]),_r(_d[11]);var l=_r(_d[12]);_r(_d[13]);var c=t(_r(_d[14])),s=this&&this.__decorate||function(t,i,o,n){var r,l=arguments.length,c=l<3?i:null===n?n=Object.getOwnPropertyDescriptor(i,o):n;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)c=Reflect.decorate(t,i,o,n);else for(var s=t.length-1;s>=0;s--)(r=t[s])&&(c=(l<3?r(c):l>3?r(i,o,c):r(i,o))||c);return l>3&&c&&Object.defineProperty(i,o,c),c};let d=e.W3mConnectingWcQrcode=class extends l.W3mConnectingWidget{constructor(){super(),this.forceUpdate=()=>{this.requestUpdate()},window.addEventListener('resize',this.forceUpdate),n.EventsController.sendEvent({type:'track',event:'SELECT_WALLET',properties:{name:this.wallet?.name??'WalletConnect',platform:'qrcode'}})}disconnectedCallback(){super.disconnectedCallback(),this.unsubscribe?.forEach(t=>t()),window.removeEventListener('resize',this.forceUpdate)}render(){return this.onRenderProxy(),i.html`
      <wui-flex
        flexDirection="column"
        alignItems="center"
        .padding=${['0','xl','xl','xl']}
        gap="xl"
      >
        <wui-shimmer borderRadius="l" width="100%"> ${this.qrCodeTemplate()} </wui-shimmer>

        <wui-text variant="paragraph-500" color="fg-100">
          Scan this QR Code with your phone
        </wui-text>
        ${this.copyTemplate()}
      </wui-flex>
      <w3m-mobile-download-links .wallet=${this.wallet}></w3m-mobile-download-links>
    `}onRenderProxy(){!this.ready&&this.uri&&(this.timeout=setTimeout(()=>{this.ready=!0},200))}qrCodeTemplate(){if(!this.uri||!this.ready)return null;const t=this.getBoundingClientRect().width-40,r=this.wallet?this.wallet.name:void 0;return n.ConnectionController.setWcLinking(void 0),n.ConnectionController.setRecentWallet(this.wallet),i.html` <wui-qr-code
      size=${t}
      theme=${n.ThemeController.state.themeMode}
      uri=${this.uri}
      imageSrc=${(0,o.ifDefined)(n.AssetUtil.getWalletImage(this.wallet))}
      color=${(0,o.ifDefined)(n.ThemeController.state.themeVariables['--w3m-qr-color'])}
      alt=${(0,o.ifDefined)(r)}
      data-testid="wui-qr-code"
    ></wui-qr-code>`}copyTemplate(){const t=!this.uri||!this.ready;return i.html`<wui-link
      .disabled=${t}
      @click=${this.onCopyUri}
      color="fg-200"
      data-testid="copy-wc2-uri"
    >
      <wui-icon size="xs" color="fg-200" slot="iconLeft" name="copy"></wui-icon>
      Copy link
    </wui-link>`}};d.styles=c.default,e.W3mConnectingWcQrcode=d=s([(0,r.customElement)('w3m-connecting-wc-qrcode')],d)},6956,[2,4951,4974,4631,4948,4971,4997,6939,6957,6989,4998,6992,6934,6946,6996]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0});var n=r(d[0]);Object.keys(n).forEach(function(t){"default"!==t&&"__esModule"!==t&&(t in e&&e[t]===n[t]||Object.defineProperty(e,t,{enumerable:!0,get:function(){return n[t]}}))})},6957,[6958]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.WuiQrCode=void 0;var r=_r(_d[1]),i=_r(_d[2]);_r(_d[3]),_r(_d[4]);var o=_r(_d[5]),s=_r(_d[6]),l=_r(_d[7]),c=t(_r(_d[8])),h=this&&this.__decorate||function(t,r,i,o){var s,l=arguments.length,c=l<3?r:null===o?o=Object.getOwnPropertyDescriptor(r,i):o;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)c=Reflect.decorate(t,r,i,o);else for(var h=t.length-1;h>=0;h--)(s=t[h])&&(c=(l<3?s(c):l>3?s(r,i,c):s(r,i))||c);return l>3&&c&&Object.defineProperty(r,i,c),c};let p=e.WuiQrCode=class extends r.LitElement{constructor(){super(...arguments),this.uri='',this.size=0,this.theme='dark',this.imageSrc=void 0,this.alt=void 0,this.arenaClear=void 0,this.farcaster=void 0}render(){return this.dataset.theme=this.theme,this.dataset.clear=String(this.arenaClear),this.style.cssText=`\n     --local-size: ${this.size}px;\n     --local-icon-color: ${this.color??"#3396ff"}\n    `,r.html`${this.templateVisual()} ${this.templateSvg()}`}templateSvg(){const t='light'===this.theme?this.size:this.size-32;return r.svg`
      <svg height=${t} width=${t}>
        ${o.QrCodeUtil.generate({uri:this.uri,size:t,logoSize:this.arenaClear?0:t/4,dotColor:this.color})}
      </svg>
    `}templateVisual(){return this.imageSrc?r.html`<wui-image src=${this.imageSrc} alt=${this.alt??'logo'}></wui-image>`:this.farcaster?r.html`<wui-icon
        class="farcaster"
        size="inherit"
        color="inherit"
        name="farcaster"
      ></wui-icon>`:r.html`<wui-icon size="inherit" color="inherit" name="walletConnect"></wui-icon>`}};p.styles=[s.resetStyles,c.default],h([(0,i.property)()],p.prototype,"uri",void 0),h([(0,i.property)({type:Number})],p.prototype,"size",void 0),h([(0,i.property)()],p.prototype,"theme",void 0),h([(0,i.property)()],p.prototype,"imageSrc",void 0),h([(0,i.property)()],p.prototype,"alt",void 0),h([(0,i.property)()],p.prototype,"color",void 0),h([(0,i.property)({type:Boolean})],p.prototype,"arenaClear",void 0),h([(0,i.property)({type:Boolean})],p.prototype,"farcaster",void 0),e.WuiQrCode=p=h([(0,l.customElement)('wui-qr-code')],p)},6958,[2,4951,4960,4976,4991,6959,4950,4959,6988]);
__d(function(g,r,_i,_a,m,e,d){var t=r(d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.QrCodeUtil=void 0;var o=t(r(d[1])),n=r(d[2]);function s(t,o,n){if(t===o)return!1;return(t-o<0?o-t:t-o)<=n+.1}function c(t,n){const s=Array.prototype.slice.call(o.default.create(t,{errorCorrectionLevel:n}).modules.data,0),c=Math.sqrt(s.length);return s.reduce((t,o,n)=>(n%c===0?t.push([o]):t[t.length-1].push(o))&&t,[])}e.QrCodeUtil={generate({uri:t,size:o,logoSize:h,dotColor:l="#141414"}){const i=[],u=c(t,'Q'),a=o/u.length,f=[{x:0,y:0},{x:1,y:0},{x:0,y:1}];f.forEach(({x:t,y:o})=>{const s=(u.length-7)*a*t,c=(u.length-7)*a*o,h=.45;for(let t=0;t<f.length;t+=1){const o=a*(7-2*t);i.push(n.svg`
            <rect
              fill=${2===t?l:"transparent"}
              width=${0===t?o-5:o}
              rx= ${0===t?(o-5)*h:o*h}
              ry= ${0===t?(o-5)*h:o*h}
              stroke=${l}
              stroke-width=${0===t?5:0}
              height=${0===t?o-5:o}
              x= ${0===t?c+a*t+2.5:c+a*t}
              y= ${0===t?s+a*t+2.5:s+a*t}
            />
          `)}});const $=Math.floor((h+25)/a),p=u.length/2-$/2,y=u.length/2+$/2-1,v=[];u.forEach((t,o)=>{t.forEach((t,n)=>{if(u[o][n]&&!(o<7&&n<7||o>u.length-8&&n<7||o<7&&n>u.length-8||o>p&&o<y&&n>p&&n<y)){const t=o*a+a/2,s=n*a+a/2;v.push([t,s])}})});const x={};return v.forEach(([t,o])=>{x[t]?x[t]?.push(o):x[t]=[o]}),Object.entries(x).map(([t,o])=>{const n=o.filter(t=>o.every(o=>!s(t,o,a)));return[Number(t),n]}).forEach(([t,o])=>{o.forEach(o=>{i.push(n.svg`<circle cx=${t} cy=${o} fill=${l} r=${a/2.5} />`)})}),Object.entries(x).filter(([t,o])=>o.length>1).map(([t,o])=>{const n=o.filter(t=>o.some(o=>s(t,o,a)));return[Number(t),n]}).map(([t,o])=>{o.sort((t,o)=>t<o?-1:1);const n=[];for(const t of o){const o=n.find(o=>o.some(o=>s(t,o,a)));o?o.push(t):n.push([t])}return[t,n.map(t=>[t[0],t[t.length-1]])]}).forEach(([t,o])=>{o.forEach(([o,s])=>{i.push(n.svg`
              <line
                x1=${t}
                x2=${t}
                y1=${o}
                y2=${s}
                stroke=${l}
                stroke-width=${a/1.25}
                stroke-linecap="round"
              />
            `)})}),i}}},6959,[2,6960,4951]);
__d(function(g,r,i,a,m,_e,d){const t=r(d[0]),n=r(d[1]),e=r(d[2]),o=r(d[3]);function c(e,o,c,l,u){const f=[].slice.call(arguments,1),s=f.length,v='function'==typeof f[s-1];if(!v&&!t())throw new Error('Callback required as last argument');if(!v){if(s<1)throw new Error('Too few arguments provided');return 1===s?(c=o,o=l=void 0):2!==s||o.getContext||(l=c,c=o,o=void 0),new Promise(function(t,u){try{const u=n.create(c,l);t(e(u,o,l))}catch(t){u(t)}})}if(s<2)throw new Error('Too few arguments provided');2===s?(u=c,c=o,o=l=void 0):3===s&&(o.getContext&&void 0===u?(u=l,l=void 0):(u=l,l=c,c=o,o=void 0));try{const t=n.create(c,l);u(null,e(t,o,l))}catch(t){u(t)}}_e.create=n.create,_e.toCanvas=c.bind(null,e.render),_e.toDataURL=c.bind(null,e.renderToDataURL),_e.toString=c.bind(null,function(t,n,e){return o.render(t,e)})},6960,[6961,6962,6985,6987]);
__d(function(g,r,i,a,m,e,d){m.exports=function(){return'function'==typeof Promise&&Promise.prototype&&Promise.prototype.then}},6961,[]);
__d(function(g,_r,_i,a,m,e,d){const t=_r(d[0]),o=_r(d[1]),n=_r(d[2]),r=_r(d[3]),s=_r(d[4]),i=_r(d[5]),f=_r(d[6]),c=_r(d[7]),l=_r(d[8]),u=_r(d[9]),h=_r(d[10]),w=_r(d[11]),C=_r(d[12]);function y(t,o){const n=t.size,r=i.getPositions(o);for(let o=0;o<r.length;o++){const s=r[o][0],i=r[o][1];for(let o=-1;o<=7;o++)if(!(s+o<=-1||n<=s+o))for(let r=-1;r<=7;r++)i+r<=-1||n<=i+r||(o>=0&&o<=6&&(0===r||6===r)||r>=0&&r<=6&&(0===o||6===o)||o>=2&&o<=4&&r>=2&&r<=4?t.set(s+o,i+r,!0,!0):t.set(s+o,i+r,!1,!0))}}function S(t){const o=t.size;for(let n=8;n<o-8;n++){const o=n%2==0;t.set(n,6,o,!0),t.set(6,n,o,!0)}}function p(t,o){const n=s.getPositions(o);for(let o=0;o<n.length;o++){const r=n[o][0],s=n[o][1];for(let o=-2;o<=2;o++)for(let n=-2;n<=2;n++)-2===o||2===o||-2===n||2===n||0===o&&0===n?t.set(r+o,s+n,!0,!0):t.set(r+o,s+n,!1,!0)}}function v(t,o){const n=t.size,r=u.getEncodedBits(o);let s,i,f;for(let o=0;o<18;o++)s=Math.floor(o/3),i=o%3+n-8-3,f=1==(r>>o&1),t.set(s,i,f,!0),t.set(i,s,f,!0)}function B(t,o,n){const r=t.size,s=h.getEncodedBits(o,n);let i,f;for(i=0;i<15;i++)f=1==(s>>i&1),i<6?t.set(i,8,f,!0):i<8?t.set(i+1,8,f,!0):t.set(r-15+i,8,f,!0),i<8?t.set(8,r-i-1,f,!0):i<9?t.set(8,15-i-1+1,f,!0):t.set(8,15-i-1,f,!0);t.set(r-8,8,1,!0)}function b(t,o){const n=t.size;let r=-1,s=n-1,i=7,f=0;for(let c=n-1;c>0;c-=2)for(6===c&&c--;;){for(let n=0;n<2;n++)if(!t.isReserved(s,c-n)){let r=!1;f<o.length&&(r=1==(o[f]>>>i&1)),t.set(s,c-n,r),i--,-1===i&&(f++,i=7)}if(s+=r,s<0||n<=s){s-=r,r=-r;break}}}function M(o,r,s){const i=new n;s.forEach(function(t){i.put(t.mode.bit,4),i.put(t.getLength(),w.getCharCountIndicator(t.mode,o)),t.write(i)});const f=8*(t.getSymbolTotalCodewords(o)-c.getTotalCodewordsCount(o,r));for(i.getLengthInBits()+4<=f&&i.put(0,4);i.getLengthInBits()%8!=0;)i.putBit(0);const l=(f-i.getLengthInBits())/8;for(let t=0;t<l;t++)i.put(t%2?17:236,8);return I(i,o,r)}function I(o,n,r){const s=t.getSymbolTotalCodewords(n),i=s-c.getTotalCodewordsCount(n,r),f=c.getBlocksCount(n,r),u=f-s%f,h=Math.floor(s/f),w=Math.floor(i/f),C=w+1,y=h-w,S=new l(y);let p=0;const v=new Array(f),B=new Array(f);let b=0;const M=new Uint8Array(o.buffer);for(let t=0;t<f;t++){const o=t<u?w:C;v[t]=M.slice(p,p+o),B[t]=S.encode(v[t]),p+=o,b=Math.max(b,o)}const I=new Uint8Array(s);let A,E,T=0;for(A=0;A<b;A++)for(E=0;E<f;E++)A<v[E].length&&(I[T++]=v[E][A]);for(A=0;A<y;A++)for(E=0;E<f;E++)I[T++]=B[E][A];return I}function A(o,n,s,i){let c;if(Array.isArray(o))c=C.fromArray(o);else{if('string'!=typeof o)throw new Error('Invalid data');{let t=n;if(!t){const n=C.rawSplit(o);t=u.getBestVersionForData(n,s)}c=C.fromString(o,t||40)}}const l=u.getBestVersionForData(c,s);if(!l)throw new Error('The amount of data is too big to be stored in a QR Code');if(n){if(n<l)throw new Error("\nThe chosen QR Code version cannot contain this amount of data.\nMinimum version required to store current data is: "+l+'.\n')}else n=l;const h=M(n,s,c),w=t.getSymbolSize(n),I=new r(w);return y(I,n),S(I),p(I,n),B(I,s,0),n>=7&&v(I,n),b(I,h),isNaN(i)&&(i=f.getBestMask(I,B.bind(null,I,s))),f.applyMask(i,I),B(I,s,i),{modules:I,version:n,errorCorrectionLevel:s,maskPattern:i,segments:c}}e.create=function(n,r){if(void 0===n||''===n)throw new Error('No input text');let s,i,c=o.M;return void 0!==r&&(c=o.from(r.errorCorrectionLevel,o.M),s=u.from(r.version),i=f.from(r.maskPattern),r.toSJISFunc&&t.setToSJISFunction(r.toSJISFunc)),A(n,s,c,i)}},6962,[6963,6964,6965,6966,6967,6968,6969,6970,6971,6974,6978,6975,6979]);
__d(function(g,r,i,a,m,e,d){let n;const o=[0,26,44,70,100,134,172,196,242,292,346,404,466,532,581,655,733,815,901,991,1085,1156,1258,1364,1474,1588,1706,1828,1921,2051,2185,2323,2465,2611,2761,2876,3034,3196,3362,3532,3706];e.getSymbolSize=function(n){if(!n)throw new Error('"version" cannot be null or undefined');if(n<1||n>40)throw new Error('"version" should be in range from 1 to 40');return 4*n+17},e.getSymbolTotalCodewords=function(n){return o[n]},e.getBCHDigit=function(n){let o=0;for(;0!==n;)o++,n>>>=1;return o},e.setToSJISFunction=function(o){if('function'!=typeof o)throw new Error('"toSJISFunc" is not a valid function.');n=o},e.isKanjiModeEnabled=function(){return void 0!==n},e.toSJIS=function(o){return n(o)}},6963,[]);
__d(function(g,r,i,a,m,_e,d){function t(t){if('string'!=typeof t)throw new Error('Param is not a string');switch(t.toLowerCase()){case'l':case'low':return _e.L;case'm':case'medium':return _e.M;case'q':case'quartile':return _e.Q;case'h':case'high':return _e.H;default:throw new Error('Unknown EC Level: '+t)}}_e.L={bit:1},_e.M={bit:0},_e.Q={bit:3},_e.H={bit:2},_e.isValid=function(t){return t&&void 0!==t.bit&&t.bit>=0&&t.bit<4},_e.from=function(e,n){if(_e.isValid(e))return e;try{return t(e)}catch(t){return n}}},6964,[]);
__d(function(g,r,_i,a,m,e,d){function t(){this.buffer=[],this.length=0}t.prototype={get:function(t){const n=Math.floor(t/8);return 1==(this.buffer[n]>>>7-t%8&1)},put:function(t,n){for(let h=0;h<n;h++)this.putBit(1==(t>>>n-h-1&1))},getLengthInBits:function(){return this.length},putBit:function(t){const n=Math.floor(this.length/8);this.buffer.length<=n&&this.buffer.push(0),t&&(this.buffer[n]|=128>>>this.length%8),this.length++}},m.exports=t},6965,[]);
__d(function(g,r,i,a,m,e,d){function t(t){if(!t||t<1)throw new Error('BitMatrix size must be defined and greater than 0');this.size=t,this.data=new Uint8Array(t*t),this.reservedBit=new Uint8Array(t*t)}t.prototype.set=function(t,s,n,o){const h=t*this.size+s;this.data[h]=n,o&&(this.reservedBit[h]=!0)},t.prototype.get=function(t,s){return this.data[t*this.size+s]},t.prototype.xor=function(t,s,n){this.data[t*this.size+s]^=n},t.prototype.isReserved=function(t,s){return this.reservedBit[t*this.size+s]},m.exports=t},6966,[]);
__d(function(g,r,_i,a,m,e,d){const o=r(d[0]).getSymbolSize;e.getRowColCoords=function(t){if(1===t)return[];const n=Math.floor(t/7)+2,s=o(t),l=145===s?26:2*Math.ceil((s-13)/(2*n-2)),f=[s-7];for(let o=1;o<n-1;o++)f[o]=f[o-1]-l;return f.push(6),f.reverse()},e.getPositions=function(o){const t=[],n=e.getRowColCoords(o),s=n.length;for(let o=0;o<s;o++)for(let l=0;l<s;l++)0===o&&0===l||0===o&&l===s-1||o===s-1&&0===l||t.push([n[o],n[l]]);return t}},6967,[6963]);
__d(function(g,r,i,a,m,e,d){const n=r(d[0]).getSymbolSize;e.getPositions=function(t){const o=n(t);return[[0,0],[o-7,0],[0,o-7]]}},6968,[6963]);
__d(function(g,r,_i,a,m,e,d){e.Patterns={PATTERN000:0,PATTERN001:1,PATTERN010:2,PATTERN011:3,PATTERN100:4,PATTERN101:5,PATTERN110:6,PATTERN111:7};const t=3,n=3,s=40,l=10;function o(t,n,s){switch(t){case e.Patterns.PATTERN000:return(n+s)%2==0;case e.Patterns.PATTERN001:return n%2==0;case e.Patterns.PATTERN010:return s%3==0;case e.Patterns.PATTERN011:return(n+s)%3==0;case e.Patterns.PATTERN100:return(Math.floor(n/2)+Math.floor(s/3))%2==0;case e.Patterns.PATTERN101:return n*s%2+n*s%3==0;case e.Patterns.PATTERN110:return(n*s%2+n*s%3)%2==0;case e.Patterns.PATTERN111:return(n*s%3+(n+s)%2)%2==0;default:throw new Error('bad maskPattern:'+t)}}e.isValid=function(t){return null!=t&&''!==t&&!isNaN(t)&&t>=0&&t<=7},e.from=function(t){return e.isValid(t)?parseInt(t,10):void 0},e.getPenaltyN1=function(n){const s=n.size;let l=0,o=0,P=0,T=null,c=null;for(let u=0;u<s;u++){o=P=0,T=c=null;for(let N=0;N<s;N++){let s=n.get(u,N);s===T?o++:(o>=5&&(l+=t+(o-5)),T=s,o=1),s=n.get(N,u),s===c?P++:(P>=5&&(l+=t+(P-5)),c=s,P=1)}o>=5&&(l+=t+(o-5)),P>=5&&(l+=t+(P-5))}return l},e.getPenaltyN2=function(t){const s=t.size;let l=0;for(let n=0;n<s-1;n++)for(let o=0;o<s-1;o++){const s=t.get(n,o)+t.get(n,o+1)+t.get(n+1,o)+t.get(n+1,o+1);4!==s&&0!==s||l++}return l*n},e.getPenaltyN3=function(t){const n=t.size;let l=0,o=0,P=0;for(let s=0;s<n;s++){o=P=0;for(let T=0;T<n;T++)o=o<<1&2047|t.get(s,T),T>=10&&(1488===o||93===o)&&l++,P=P<<1&2047|t.get(T,s),T>=10&&(1488===P||93===P)&&l++}return l*s},e.getPenaltyN4=function(t){let n=0;const s=t.data.length;for(let l=0;l<s;l++)n+=t.data[l];return Math.abs(Math.ceil(100*n/s/5)-10)*l},e.applyMask=function(t,n){const s=n.size;for(let l=0;l<s;l++)for(let P=0;P<s;P++)n.isReserved(P,l)||n.xor(P,l,o(t,P,l))},e.getBestMask=function(t,n){const s=Object.keys(e.Patterns).length;let l=0,o=1/0;for(let P=0;P<s;P++){n(P),e.applyMask(P,t);const s=e.getPenaltyN1(t)+e.getPenaltyN2(t)+e.getPenaltyN3(t)+e.getPenaltyN4(t);e.applyMask(P,t),s<o&&(o=s,l=P)}return l}},6969,[]);
__d(function(g,r,i,a,m,e,d){const t=r(d[0]),n=[1,1,1,1,1,1,1,1,1,1,2,2,1,2,2,4,1,2,4,4,2,4,4,4,2,4,6,5,2,4,6,6,2,5,8,8,4,5,8,8,4,5,8,11,4,8,10,11,4,9,12,16,4,9,16,16,6,10,12,18,6,10,17,16,6,11,16,19,6,13,18,21,7,14,21,25,8,16,20,25,8,17,23,25,9,17,23,34,9,18,25,30,10,20,27,32,12,21,29,35,12,23,34,37,12,25,34,40,13,26,35,42,14,28,38,45,15,29,40,48,16,31,43,51,17,33,45,54,18,35,48,57,19,37,51,60,19,38,53,63,20,40,56,66,21,43,59,70,22,45,62,74,24,47,65,77,25,49,68,81],u=[7,10,13,17,10,16,22,28,15,26,36,44,20,36,52,64,26,48,72,88,36,64,96,112,40,72,108,130,48,88,132,156,60,110,160,192,72,130,192,224,80,150,224,264,96,176,260,308,104,198,288,352,120,216,320,384,132,240,360,432,144,280,408,480,168,308,448,532,180,338,504,588,196,364,546,650,224,416,600,700,224,442,644,750,252,476,690,816,270,504,750,900,300,560,810,960,312,588,870,1050,336,644,952,1110,360,700,1020,1200,390,728,1050,1260,420,784,1140,1350,450,812,1200,1440,480,868,1290,1530,510,924,1350,1620,540,980,1440,1710,570,1036,1530,1800,570,1064,1590,1890,600,1120,1680,1980,630,1204,1770,2100,660,1260,1860,2220,720,1316,1950,2310,750,1372,2040,2430];e.getBlocksCount=function(u,c){switch(c){case t.L:return n[4*(u-1)+0];case t.M:return n[4*(u-1)+1];case t.Q:return n[4*(u-1)+2];case t.H:return n[4*(u-1)+3];default:return}},e.getTotalCodewordsCount=function(n,c){switch(c){case t.L:return u[4*(n-1)+0];case t.M:return u[4*(n-1)+1];case t.Q:return u[4*(n-1)+2];case t.H:return u[4*(n-1)+3];default:return}}},6970,[6964]);
__d(function(g,r,i,a,m,e,d){const t=r(d[0]);function n(t){this.genPoly=void 0,this.degree=t,this.degree&&this.initialize(this.degree)}n.prototype.initialize=function(n){this.degree=n,this.genPoly=t.generateECPolynomial(this.degree)},n.prototype.encode=function(n){if(!this.genPoly)throw new Error('Encoder not initialized');const o=new Uint8Array(n.length+this.degree);o.set(n);const s=t.mod(o,this.genPoly),h=this.degree-s.length;if(h>0){const t=new Uint8Array(this.degree);return t.set(s,h),t}return s},m.exports=n},6971,[6972]);
__d(function(g,r,_i,a,m,e,d){const n=r(d[0]);e.mul=function(t,l){const o=new Uint8Array(t.length+l.length-1);for(let u=0;u<t.length;u++)for(let f=0;f<l.length;f++)o[u+f]^=n.mul(t[u],l[f]);return o},e.mod=function(t,l){let o=new Uint8Array(t);for(;o.length-l.length>=0;){const t=o[0];for(let u=0;u<l.length;u++)o[u]^=n.mul(l[u],t);let u=0;for(;u<o.length&&0===o[u];)u++;o=o.slice(u)}return o},e.generateECPolynomial=function(t){let l=new Uint8Array([1]);for(let o=0;o<t;o++)l=e.mul(l,new Uint8Array([1,n.exp(o)]));return l}},6972,[6973]);
__d(function(g,r,_i,a,m,e,d){const n=new Uint8Array(512),t=new Uint8Array(256);!(function(){let o=1;for(let u=0;u<255;u++)n[u]=o,t[o]=u,o<<=1,256&o&&(o^=285);for(let t=255;t<512;t++)n[t]=n[t-255]})(),e.log=function(n){if(n<1)throw new Error('log('+n+')');return t[n]},e.exp=function(t){return n[t]},e.mul=function(o,u){return 0===o||0===u?0:n[t[o]+t[u]]}},6973,[]);
__d(function(g,r,i,a,m,e,_d){const t=r(_d[0]),n=r(_d[1]),o=r(_d[2]),f=r(_d[3]),u=r(_d[4]),c=t.getBCHDigit(7973);function s(t,n,o){for(let f=1;f<=40;f++)if(n<=e.getCapacity(f,o,t))return f}function l(t,n){return f.getCharCountIndicator(t,n)+4}function d(t,n){let o=0;return t.forEach(function(t){const f=l(t.mode,n);o+=f+t.getBitsLength()}),o}function C(t,n){for(let o=1;o<=40;o++){if(d(t,o)<=e.getCapacity(o,n,f.MIXED))return o}}e.from=function(t,n){return u.isValid(t)?parseInt(t,10):n},e.getCapacity=function(o,c,s){if(!u.isValid(o))throw new Error('Invalid QR Code version');void 0===s&&(s=f.BYTE);const d=8*(t.getSymbolTotalCodewords(o)-n.getTotalCodewordsCount(o,c));if(s===f.MIXED)return d;const C=d-l(s,o);switch(s){case f.NUMERIC:return Math.floor(C/10*3);case f.ALPHANUMERIC:return Math.floor(C/11*2);case f.KANJI:return Math.floor(C/13);case f.BYTE:default:return Math.floor(C/8)}},e.getBestVersionForData=function(t,n){let f;const u=o.from(n,o.M);if(Array.isArray(t)){if(t.length>1)return C(t,u);if(0===t.length)return 1;f=t[0]}else f=t;return s(f.mode,f.getLength(),u)},e.getEncodedBits=function(n){if(!u.isValid(n)||n<7)throw new Error('Invalid QR Code version');let o=n<<12;for(;t.getBCHDigit(o)-c>=0;)o^=7973<<t.getBCHDigit(o)-c;return n<<12|o}},6974,[6963,6970,6964,6975,6976]);
__d(function(g,r,i,a,m,_e,d){const t=r(d[0]),n=r(d[1]);function e(t){if('string'!=typeof t)throw new Error('Param is not a string');switch(t.toLowerCase()){case'numeric':return _e.NUMERIC;case'alphanumeric':return _e.ALPHANUMERIC;case'kanji':return _e.KANJI;case'byte':return _e.BYTE;default:throw new Error('Unknown mode: '+t)}}_e.NUMERIC={id:'Numeric',bit:1,ccBits:[10,12,14]},_e.ALPHANUMERIC={id:'Alphanumeric',bit:2,ccBits:[9,11,13]},_e.BYTE={id:'Byte',bit:4,ccBits:[8,16,16]},_e.KANJI={id:'Kanji',bit:8,ccBits:[8,10,12]},_e.MIXED={bit:-1},_e.getCharCountIndicator=function(n,e){if(!n.ccBits)throw new Error('Invalid mode: '+n);if(!t.isValid(e))throw new Error('Invalid version: '+e);return e>=1&&e<10?n.ccBits[0]:e<27?n.ccBits[1]:n.ccBits[2]},_e.getBestModeForData=function(t){return n.testNumeric(t)?_e.NUMERIC:n.testAlphanumeric(t)?_e.ALPHANUMERIC:n.testKanji(t)?_e.KANJI:_e.BYTE},_e.toString=function(t){if(t&&t.id)return t.id;throw new Error('Invalid mode')},_e.isValid=function(t){return t&&t.bit&&t.ccBits},_e.from=function(t,n){if(_e.isValid(t))return t;try{return e(t)}catch(t){return n}}},6975,[6976,6977]);
__d(function(g,r,i,a,m,e,d){e.isValid=function(n){return!isNaN(n)&&n>=1&&n<=40}},6976,[]);
__d(function(g,r,i,a,m,e,d){let u="(?:[u3000-u303F]|[u3040-u309F]|[u30A0-u30FF]|[uFF00-uFFEF]|[u4E00-u9FAF]|[u2605-u2606]|[u2190-u2195]|u203B|[u2010u2015u2018u2019u2025u2026u201Cu201Du2225u2260]|[u0391-u0451]|[u00A7u00A8u00B1u00B4u00D7u00F7])+";u=u.replace(/u/g,'\\u');const n='(?:(?![A-Z0-9 $%*+\\-./:]|'+u+')(?:.|[\r\n]))+';e.KANJI=new RegExp(u,'g'),e.BYTE_KANJI=new RegExp('[^A-Z0-9 $%*+\\-./:]+','g'),e.BYTE=new RegExp(n,'g'),e.NUMERIC=new RegExp('[0-9]+','g'),e.ALPHANUMERIC=new RegExp('[A-Z $%*+\\-./:]+','g');const t=new RegExp('^'+u+'$'),E=new RegExp("^[0-9]+$"),A=new RegExp('^[A-Z0-9 $%*+\\-./:]+$');e.testKanji=function(u){return t.test(u)},e.testNumeric=function(u){return E.test(u)},e.testAlphanumeric=function(u){return A.test(u)}},6977,[]);
__d(function(g,r,i,a,m,e,_d){const t=r(_d[0]),n=t.getBCHDigit(1335);e.getEncodedBits=function(o,c){const B=o.bit<<3|c;let d=B<<10;for(;t.getBCHDigit(d)-n>=0;)d^=1335<<t.getBCHDigit(d)-n;return 21522^(B<<10|d)}},6978,[6963]);
__d(function(g,r,_i,a,m,e,d){const t=r(d[0]),n=r(d[1]),o=r(d[2]),u=r(d[3]),s=r(d[4]),l=r(d[5]),c=r(d[6]),h=r(d[7]);function i(t){return unescape(encodeURIComponent(t)).length}function f(t,n,o){const u=[];let s;for(;null!==(s=t.exec(o));)u.push({data:s[0],index:s.index,mode:n,length:s[0].length});return u}function E(n){const o=f(l.NUMERIC,t.NUMERIC,n),u=f(l.ALPHANUMERIC,t.ALPHANUMERIC,n);let s,h;c.isKanjiModeEnabled()?(s=f(l.BYTE,t.BYTE,n),h=f(l.KANJI,t.KANJI,n)):(s=f(l.BYTE_KANJI,t.BYTE,n),h=[]);return o.concat(u,s,h).sort(function(t,n){return t.index-n.index}).map(function(t){return{data:t.data,mode:t.mode,length:t.length}})}function A(l,c){switch(c){case t.NUMERIC:return n.getBitsLength(l);case t.ALPHANUMERIC:return o.getBitsLength(l);case t.KANJI:return s.getBitsLength(l);case t.BYTE:return u.getBitsLength(l)}}function I(t){return t.reduce(function(t,n){const o=t.length-1>=0?t[t.length-1]:null;return o&&o.mode===n.mode?(t[t.length-1].data+=n.data,t):(t.push(n),t)},[])}function C(n){const o=[];for(let u=0;u<n.length;u++){const s=n[u];switch(s.mode){case t.NUMERIC:o.push([s,{data:s.data,mode:t.ALPHANUMERIC,length:s.length},{data:s.data,mode:t.BYTE,length:s.length}]);break;case t.ALPHANUMERIC:o.push([s,{data:s.data,mode:t.BYTE,length:s.length}]);break;case t.KANJI:o.push([s,{data:s.data,mode:t.BYTE,length:i(s.data)}]);break;case t.BYTE:o.push([{data:s.data,mode:t.BYTE,length:i(s.data)}])}}return o}function p(n,o){const u={},s={start:{}};let l=['start'];for(let c=0;c<n.length;c++){const h=n[c],i=[];for(let n=0;n<h.length;n++){const f=h[n],E=''+c+n;i.push(E),u[E]={node:f,lastCount:0},s[E]={};for(let n=0;n<l.length;n++){const c=l[n];u[c]&&u[c].node.mode===f.mode?(s[c][E]=A(u[c].lastCount+f.length,f.mode)-A(u[c].lastCount,f.mode),u[c].lastCount+=f.length):(u[c]&&(u[c].lastCount=f.length),s[c][E]=A(f.length,f.mode)+4+t.getCharCountIndicator(f.mode,o))}}l=i}for(let t=0;t<l.length;t++)s[l[t]].end=0;return{map:s,table:u}}function B(l,h){let i;const f=t.getBestModeForData(l);if(i=t.from(h,f),i!==t.BYTE&&i.bit<f.bit)throw new Error('"'+l+"\" cannot be encoded with mode "+t.toString(i)+'.\n Suggested mode is: '+t.toString(f));switch(i!==t.KANJI||c.isKanjiModeEnabled()||(i=t.BYTE),i){case t.NUMERIC:return new n(l);case t.ALPHANUMERIC:return new o(l);case t.KANJI:return new s(l);case t.BYTE:return new u(l)}}e.fromArray=function(t){return t.reduce(function(t,n){return'string'==typeof n?t.push(B(n,null)):n.data&&t.push(B(n.data,n.mode)),t},[])},e.fromString=function(t,n){const o=p(C(E(t,c.isKanjiModeEnabled())),n),u=h.find_path(o.map,'start','end'),s=[];for(let t=1;t<u.length-1;t++)s.push(o.table[u[t]].node);return e.fromArray(I(s))},e.rawSplit=function(t){return e.fromArray(E(t,c.isKanjiModeEnabled()))}},6979,[6975,6980,6981,6982,6984,6977,6963,1453]);
__d(function(g,r,_i,a,m,e,d){const t=r(d[0]);function n(n){this.mode=t.NUMERIC,this.data=n.toString()}n.getBitsLength=function(t){return 10*Math.floor(t/3)+(t%3?t%3*3+1:0)},n.prototype.getLength=function(){return this.data.length},n.prototype.getBitsLength=function(){return n.getBitsLength(this.data.length)},n.prototype.write=function(t){let n,o,s;for(n=0;n+3<=this.data.length;n+=3)o=this.data.substr(n,3),s=parseInt(o,10),t.put(s,10);const i=this.data.length-n;i>0&&(o=this.data.substr(n),s=parseInt(o,10),t.put(s,3*i+1))},m.exports=n},6980,[6975]);
__d(function(g,r,_i,a,m,e,d){const t=r(d[0]),n=['0','1','2','3','4','5','6','7','8','9','A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U','V','W','X','Y','Z',' ','$','%','*','+','-','.','/',':'];function i(n){this.mode=t.ALPHANUMERIC,this.data=n}i.getBitsLength=function(t){return 11*Math.floor(t/2)+t%2*6},i.prototype.getLength=function(){return this.data.length},i.prototype.getBitsLength=function(){return i.getBitsLength(this.data.length)},i.prototype.write=function(t){let i;for(i=0;i+2<=this.data.length;i+=2){let h=45*n.indexOf(this.data[i]);h+=n.indexOf(this.data[i+1]),t.put(h,11)}this.data.length%2&&t.put(n.indexOf(this.data[i]),6)},m.exports=i},6981,[6975]);
__d(function(g,r,_i,a,m,e,d){const t=r(d[0]),n=r(d[1]);function i(i){this.mode=n.BYTE,'string'==typeof i&&(i=t(i)),this.data=new Uint8Array(i)}i.getBitsLength=function(t){return 8*t},i.prototype.getLength=function(){return this.data.length},i.prototype.getBitsLength=function(){return i.getBitsLength(this.data.length)},i.prototype.write=function(t){for(let n=0,i=this.data.length;n<i;n++)t.put(this.data[n],8)},m.exports=i},6982,[6983,6975]);
__d(function(g,r,i,a,m,e,d){'use strict';m.exports=function(u){for(var h=[],s=u.length,p=0;p<s;p++){var t=u.charCodeAt(p);if(t>=55296&&t<=56319&&s>p+1){var n=u.charCodeAt(p+1);n>=56320&&n<=57343&&(t=1024*(t-55296)+n-56320+65536,p+=1)}t<128?h.push(t):t<2048?(h.push(t>>6|192),h.push(63&t|128)):t<55296||t>=57344&&t<65536?(h.push(t>>12|224),h.push(t>>6&63|128),h.push(63&t|128)):t>=65536&&t<=1114111?(h.push(t>>18|240),h.push(t>>12&63|128),h.push(t>>6&63|128),h.push(63&t|128)):h.push(239,191,189)}return new Uint8Array(h).buffer}},6983,[]);
__d(function(g,r,_i,a,m,e,d){const t=r(d[0]),n=r(d[1]);function i(n){this.mode=t.KANJI,this.data=n}i.getBitsLength=function(t){return 13*t},i.prototype.getLength=function(){return this.data.length},i.prototype.getBitsLength=function(){return i.getBitsLength(this.data.length)},i.prototype.write=function(t){let i;for(i=0;i<this.data.length;i++){let o=n.toSJIS(this.data[i]);if(o>=33088&&o<=40956)o-=33088;else{if(!(o>=57408&&o<=60351))throw new Error('Invalid SJIS character: '+this.data[i]+"\nMake sure your charset is UTF-8");o-=49472}o=192*(o>>>8&255)+(255&o),t.put(o,13)}},m.exports=i},6984,[6975,6963]);
__d(function(g,r,i,a,m,_e,d){const t=r(d[0]);function e(t,e,n){t.clearRect(0,0,e.width,e.height),e.style||(e.style={}),e.height=n,e.width=n,e.style.height=n+'px',e.style.width=n+'px'}function n(){try{return document.createElement('canvas')}catch(t){throw new Error('You need to specify a canvas element')}}_e.render=function(o,c,s){let u=s,h=c;void 0!==u||c&&c.getContext||(u=c,c=void 0),c||(h=n()),u=t.getOptions(u);const l=t.getImageWidth(o.modules.size,u),p=h.getContext('2d'),y=p.createImageData(l,l);return t.qrToImageData(y.data,o,u),e(p,h,l),p.putImageData(y,0,0),h},_e.renderToDataURL=function(t,e,n){let o=n;void 0!==o||e&&e.getContext||(o=e,e=void 0),o||(o={});const c=_e.render(t,e,o),s=o.type||'image/png',u=o.rendererOpts||{};return c.toDataURL(s,u.quality)}},6985,[6986]);
__d(function(g,r,_i,a,m,e,d){function t(t){if('number'==typeof t&&(t=t.toString()),'string'!=typeof t)throw new Error('Color should be defined as hex string');let o=t.slice().replace('#','').split('');if(o.length<3||5===o.length||o.length>8)throw new Error('Invalid hex color: '+t);3!==o.length&&4!==o.length||(o=Array.prototype.concat.apply([],o.map(function(t){return[t,t]}))),6===o.length&&o.push('F','F');const n=parseInt(o.join(''),16);return{r:n>>24&255,g:n>>16&255,b:n>>8&255,a:255&n,hex:'#'+o.slice(0,6).join('')}}e.getOptions=function(o){o||(o={}),o.color||(o.color={});const n=void 0===o.margin||null===o.margin||o.margin<0?4:o.margin,i=o.width&&o.width>=21?o.width:void 0,l=o.scale||4;return{width:i,scale:i?4:l,margin:n,color:{dark:t(o.color.dark||'#000000ff'),light:t(o.color.light||'#ffffffff')},type:o.type,rendererOpts:o.rendererOpts||{}}},e.getScale=function(t,o){return o.width&&o.width>=t+2*o.margin?o.width/(t+2*o.margin):o.scale},e.getImageWidth=function(t,o){const n=e.getScale(t,o);return Math.floor((t+2*o.margin)*n)},e.qrToImageData=function(t,o,n){const i=o.modules.size,l=o.modules.data,c=e.getScale(i,n),f=Math.floor((i+2*n.margin)*c),h=n.margin*c,s=[n.color.light,n.color.dark];for(let o=0;o<f;o++)for(let u=0;u<f;u++){let p=4*(o*f+u),w=n.color.light;if(o>=h&&u>=h&&o<f-h&&u<f-h){w=s[l[Math.floor((o-h)/c)*i+Math.floor((u-h)/c)]?1:0]}t[p++]=w.r,t[p++]=w.g,t[p++]=w.b,t[p]=w.a}}},6986,[]);
__d(function(g,r,_i,a,m,e,d){const t=r(d[0]);function o(t,o){const n=t.a/255,i=o+'="'+t.hex+'"';return n<1?i+' '+o+'-opacity="'+n.toFixed(2).slice(1)+'"':i}function n(t,o,n){let i=t+o;return void 0!==n&&(i+=' '+n),i}function i(t,o,i){let l='',h=0,s=!1,c=0;for(let u=0;u<t.length;u++){const f=Math.floor(u%o),w=Math.floor(u/o);f||s||(s=!0),t[u]?(c++,u>0&&f>0&&t[u-1]||(l+=s?n('M',f+i,.5+w+i):n('m',h,0),h=0,s=!1),f+1<o&&t[u+1]||(l+=n('h',c),c=0)):h++}return l}e.render=function(n,l,h){const s=t.getOptions(l),c=n.modules.size,u=n.modules.data,f=c+2*s.margin,w=s.color.light.a?'<path '+o(s.color.light,'fill')+' d="M0 0h'+f+'v'+f+'H0z"/>':'',p='<path '+o(s.color.dark,'stroke')+' d="'+i(u,c,s.margin)+'"/>',v="viewBox=\"0 0 "+f+' '+f+'"',x='<svg xmlns="http://www.w3.org/2000/svg" '+(s.width?'width="'+s.width+'" height="'+s.width+'" ':'')+v+' shape-rendering="crispEdges">'+w+p+'</svg>\n';return'function'==typeof h&&h(null,x),x}},6987,[6986]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var o=r(d[0]);e.default=o.css`
  :host {
    position: relative;
    user-select: none;
    display: block;
    overflow: hidden;
    aspect-ratio: 1 / 1;
    width: var(--local-size);
  }

  :host([data-theme='dark']) {
    border-radius: clamp(0px, var(--wui-border-radius-l), 40px);
    background-color: var(--wui-color-inverse-100);
    padding: var(--wui-spacing-l);
  }

  :host([data-theme='light']) {
    box-shadow: 0 0 0 1px var(--wui-color-bg-125);
    background-color: var(--wui-color-bg-125);
  }

  :host([data-clear='true']) > wui-icon {
    display: none;
  }

  svg:first-child,
  wui-image,
  wui-icon {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translateY(-50%) translateX(-50%);
  }

  wui-image {
    width: 25%;
    height: 25%;
    border-radius: var(--wui-border-radius-xs);
  }

  wui-icon {
    width: 100%;
    height: 100%;
    color: var(--local-icon-color) !important;
    transform: translateY(-50%) translateX(-50%) scale(0.25);
  }
`},6988,[4951]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0});var n=r(d[0]);Object.keys(n).forEach(function(t){"default"!==t&&"__esModule"!==t&&(t in e&&e[t]===n[t]||Object.defineProperty(e,t,{enumerable:!0,get:function(){return n[t]}}))})},6989,[6990]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.WuiShimmer=void 0;var r=_r(_d[1]),i=_r(_d[2]),o=_r(_d[3]),s=t(_r(_d[4])),d=this&&this.__decorate||function(t,r,i,o){var s,d=arguments.length,h=d<3?r:null===o?o=Object.getOwnPropertyDescriptor(r,i):o;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)h=Reflect.decorate(t,r,i,o);else for(var p=t.length-1;p>=0;p--)(s=t[p])&&(h=(d<3?s(h):d>3?s(r,i,h):s(r,i))||h);return d>3&&h&&Object.defineProperty(r,i,h),h};let h=e.WuiShimmer=class extends r.LitElement{constructor(){super(...arguments),this.width='',this.height='',this.borderRadius='m',this.variant='default'}render(){return this.style.cssText=`\n      width: ${this.width};\n      height: ${this.height};\n      border-radius: clamp(0px,var(--wui-border-radius-${this.borderRadius}), 40px);\n    `,r.html`<slot></slot>`}};h.styles=[s.default],d([(0,i.property)()],h.prototype,"width",void 0),d([(0,i.property)()],h.prototype,"height",void 0),d([(0,i.property)()],h.prototype,"borderRadius",void 0),d([(0,i.property)()],h.prototype,"variant",void 0),e.WuiShimmer=h=d([(0,o.customElement)('wui-shimmer')],h)},6990,[2,4951,4960,4959,6991]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var o=r(d[0]);e.default=o.css`
  :host {
    display: block;
    box-shadow: inset 0 0 0 1px var(--wui-color-gray-glass-005);
    background: linear-gradient(
      120deg,
      var(--wui-color-bg-200) 5%,
      var(--wui-color-bg-200) 48%,
      var(--wui-color-bg-300) 55%,
      var(--wui-color-bg-300) 60%,
      var(--wui-color-bg-300) calc(60% + 10px),
      var(--wui-color-bg-200) calc(60% + 12px),
      var(--wui-color-bg-200) 100%
    );
    background-size: 250%;
    animation: shimmer 3s linear infinite reverse;
  }

  :host([variant='light']) {
    background: linear-gradient(
      120deg,
      var(--wui-color-bg-150) 5%,
      var(--wui-color-bg-150) 48%,
      var(--wui-color-bg-200) 55%,
      var(--wui-color-bg-200) 60%,
      var(--wui-color-bg-200) calc(60% + 10px),
      var(--wui-color-bg-150) calc(60% + 12px),
      var(--wui-color-bg-150) 100%
    );
    background-size: 250%;
  }

  @keyframes shimmer {
    from {
      background-position: -250% 0;
    }
    to {
      background-position: 250% 0;
    }
  }
`},6991,[4951]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0});var n=r(d[0]);Object.keys(n).forEach(function(t){"default"!==t&&"__esModule"!==t&&(t in e&&e[t]===n[t]||Object.defineProperty(e,t,{enumerable:!0,get:function(){return n[t]}}))})},6992,[6993]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.WuiUxByReown=void 0;var n=_r(_d[1]);_r(_d[2]),_r(_d[3]),_r(_d[4]);var r=_r(_d[5]),o=_r(_d[6]),l=_r(_d[7]),i=t(_r(_d[8])),c=this&&this.__decorate||function(t,n,r,o){var l,i=arguments.length,c=i<3?n:null===o?o=Object.getOwnPropertyDescriptor(n,r):o;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)c=Reflect.decorate(t,n,r,o);else for(var s=t.length-1;s>=0;s--)(l=t[s])&&(c=(i<3?l(c):i>3?l(n,r,c):l(n,r))||c);return i>3&&c&&Object.defineProperty(n,r,c),c};let s=e.WuiUxByReown=class extends n.LitElement{render(){return n.html`
      <a
        data-testid="ux-branding-reown"
        href=${r.REOWN_URL}
        rel="noreferrer"
        target="_blank"
        style="text-decoration: none;"
      >
        <wui-flex
          justifyContent="center"
          alignItems="center"
          gap="xs"
          .padding=${['0','0','l','0']}
        >
          <wui-text variant="small-500" color="fg-100"> UX by </wui-text>
          <wui-icon name="reown" size="xxxl" class="reown-logo"></wui-icon>
        </wui-flex>
      </a>
    `}};s.styles=[o.resetStyles,o.elementStyles,i.default],e.WuiUxByReown=s=c([(0,l.customElement)('wui-ux-by-reown')],s)},6993,[2,4951,4976,4985,4972,6994,4950,4959,6995]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.specialCharactersRegex=e.numbersRegex=e.REOWN_URL=void 0;e.specialCharactersRegex=/[.*+?^${}()|[\]\\]/gu,e.numbersRegex=/[0-9,.]/u,e.REOWN_URL='https://reown.com'},6994,[]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var o=r(d[0]);e.default=o.css`
  .reown-logo {
    height: var(--wui-spacing-xxl);
  }

  a {
    text-decoration: none;
    cursor: pointer;
  }

  a:hover {
    opacity: 0.9;
  }
`},6995,[4951]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var o=r(d[0]);e.default=o.css`
  @keyframes fadein {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  wui-shimmer {
    width: 100%;
    aspect-ratio: 1 / 1;
    border-radius: clamp(0px, var(--wui-border-radius-l), 40px) !important;
  }

  wui-qr-code {
    opacity: 0;
    animation-duration: 200ms;
    animation-timing-function: ease;
    animation-name: fadein;
    animation-fill-mode: forwards;
  }
`},6996,[4951]);
__d(function(g,_r,_i,a,m,e,_d){Object.defineProperty(e,"__esModule",{value:!0}),e.W3mConnectingWcUnsupported=void 0;var t=_r(_d[0]),l=_r(_d[1]),n=_r(_d[2]),r=_r(_d[3]);_r(_d[4]),_r(_d[5]),_r(_d[6]),_r(_d[7]);var o=this&&this.__decorate||function(t,l,n,r){var o,i=arguments.length,c=i<3?l:null===r?r=Object.getOwnPropertyDescriptor(l,n):r;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)c=Reflect.decorate(t,l,n,r);else for(var s=t.length-1;s>=0;s--)(o=t[s])&&(c=(i<3?o(c):i>3?o(l,n,c):o(l,n))||c);return i>3&&c&&Object.defineProperty(l,n,c),c};let i=e.W3mConnectingWcUnsupported=class extends t.LitElement{constructor(){if(super(),this.wallet=n.RouterController.state.data?.wallet,!this.wallet)throw new Error('w3m-connecting-wc-unsupported: No wallet provided');n.EventsController.sendEvent({type:'track',event:'SELECT_WALLET',properties:{name:this.wallet.name,platform:'browser'}})}render(){return t.html`
      <wui-flex
        flexDirection="column"
        alignItems="center"
        .padding=${['3xl','xl','xl','xl']}
        gap="xl"
      >
        <wui-wallet-image
          size="lg"
          imageSrc=${(0,l.ifDefined)(n.AssetUtil.getWalletImage(this.wallet))}
        ></wui-wallet-image>

        <wui-text variant="paragraph-500" color="fg-100">Not Detected</wui-text>
      </wui-flex>

      <w3m-mobile-download-links .wallet=${this.wallet}></w3m-mobile-download-links>
    `}};e.W3mConnectingWcUnsupported=i=o([(0,r.customElement)('w3m-connecting-wc-unsupported')],i)},6997,[4951,4974,4631,4948,4971,4998,6945,6946]);
__d(function(g,_r,_i,a,m,e,_d){Object.defineProperty(e,"__esModule",{value:!0}),e.W3mConnectingWcWeb=void 0;var t=_r(_d[0]),n=_r(_d[1]),o=_r(_d[2]),i=_r(_d[3]),r=this&&this.__decorate||function(t,n,o,i){var r,s=arguments.length,c=s<3?n:null===i?i=Object.getOwnPropertyDescriptor(n,o):i;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)c=Reflect.decorate(t,n,o,i);else for(var l=t.length-1;l>=0;l--)(r=t[l])&&(c=(s<3?r(c):s>3?r(n,o,c):r(n,o))||c);return s>3&&c&&Object.defineProperty(n,o,c),c};let s=e.W3mConnectingWcWeb=class extends i.W3mConnectingWidget{constructor(){if(super(),this.isLoading=!0,!this.wallet)throw new Error('w3m-connecting-wc-web: No wallet provided');this.onConnect=this.onConnectProxy.bind(this),this.secondaryBtnLabel='Open',this.secondaryLabel=n.ConstantsUtil.CONNECT_LABELS.MOBILE,this.secondaryBtnIcon='externalLink',this.updateLoadingState(),this.unsubscribe.push(n.ConnectionController.subscribeKey('wcUri',()=>{this.updateLoadingState()})),n.EventsController.sendEvent({type:'track',event:'SELECT_WALLET',properties:{name:this.wallet.name,platform:'web'}})}updateLoadingState(){this.isLoading=!this.uri}onConnectProxy(){if(this.wallet?.webapp_link&&this.uri)try{this.error=!1;const{webapp_link:t,name:o}=this.wallet,{redirect:i,href:r}=n.CoreHelperUtil.formatUniversalUrl(t,this.uri);n.ConnectionController.setWcLinking({name:o,href:r}),n.ConnectionController.setRecentWallet(this.wallet),n.CoreHelperUtil.openHref(i,'_blank')}catch{this.error=!0}}};r([(0,t.state)()],s.prototype,"isLoading",void 0),e.W3mConnectingWcWeb=s=r([(0,o.customElement)('w3m-connecting-wc-web')],s)},6998,[4960,4631,4948,6934]);
__d(function(g,_r,_i,a,m,e,_d){Object.defineProperty(e,"__esModule",{value:!0}),e.W3mAllWalletsView=void 0;var t=_r(_d[0]),i=_r(_d[1]),l=_r(_d[2]),n=_r(_d[3]),o=_r(_d[4]);_r(_d[5]),_r(_d[6]),_r(_d[7]),_r(_d[8]),_r(_d[9]),_r(_d[10]);var r=this&&this.__decorate||function(t,i,l,n){var o,r=arguments.length,c=r<3?i:null===n?n=Object.getOwnPropertyDescriptor(i,l):n;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)c=Reflect.decorate(t,i,l,n);else for(var s=t.length-1;s>=0;s--)(o=t[s])&&(c=(r<3?o(c):r>3?o(i,l,c):o(i,l))||c);return r>3&&c&&Object.defineProperty(i,l,c),c};let c=e.W3mAllWalletsView=class extends t.LitElement{constructor(){super(...arguments),this.search='',this.onDebouncedSearch=n.CoreHelperUtil.debounce(t=>{this.search=t})}render(){const i=this.search.length>=2;return t.html`
      <wui-flex .padding=${['0','s','s','s']} gap="xs">
        <wui-search-bar @inputChange=${this.onInputChange.bind(this)}></wui-search-bar>
        <wui-certified-switch
          ?checked=${this.badge}
          @click=${this.onClick.bind(this)}
          data-testid="wui-certified-switch"
        ></wui-certified-switch>
        ${this.qrButtonTemplate()}
      </wui-flex>
      ${i||this.badge?t.html`<w3m-all-wallets-search
            query=${this.search}
            badge=${(0,l.ifDefined)(this.badge)}
          ></w3m-all-wallets-search>`:t.html`<w3m-all-wallets-list badge=${(0,l.ifDefined)(this.badge)}></w3m-all-wallets-list>`}
    `}onInputChange(t){this.onDebouncedSearch(t.detail)}onClick(){'certified'!==this.badge?(this.badge='certified',n.SnackController.showSvg('Only WalletConnect certified',{icon:'walletConnectBrown',iconColor:'accent-100'})):this.badge=void 0}qrButtonTemplate(){return n.CoreHelperUtil.isMobile()?t.html`
        <wui-icon-box
          size="lg"
          iconSize="xl"
          iconColor="accent-100"
          backgroundColor="accent-100"
          icon="qrCode"
          background="transparent"
          border
          borderColor="wui-accent-glass-010"
          @click=${this.onWalletConnectQr.bind(this)}
        ></wui-icon-box>
      `:null}onWalletConnectQr(){n.RouterController.push('ConnectingWalletConnect')}};r([(0,i.state)()],c.prototype,"search",void 0),r([(0,i.state)()],c.prototype,"badge",void 0),e.W3mAllWalletsView=c=r([(0,o.customElement)('w3m-all-wallets-view')],c)},6999,[4951,4960,4974,4631,4948,7000,4971,6938,7007,7014,7025]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0});var n=r(d[0]);Object.keys(n).forEach(function(t){"default"!==t&&"__esModule"!==t&&(t in e&&e[t]===n[t]||Object.defineProperty(e,t,{enumerable:!0,get:function(){return n[t]}}))})},7000,[7001]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.WuiCertifiedSwitch=void 0;var i=_r(_d[1]),c=_r(_d[2]),r=_r(_d[3]);_r(_d[4]);var o=_r(_d[5]),n=_r(_d[6]);_r(_d[7]);var l=t(_r(_d[8])),d=this&&this.__decorate||function(t,i,c,r){var o,n=arguments.length,l=n<3?i:null===r?r=Object.getOwnPropertyDescriptor(i,c):r;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)l=Reflect.decorate(t,i,c,r);else for(var d=t.length-1;d>=0;d--)(o=t[d])&&(l=(n<3?o(l):n>3?o(i,c,l):o(i,c))||l);return n>3&&l&&Object.defineProperty(i,c,l),l};let s=e.WuiCertifiedSwitch=class extends i.LitElement{constructor(){super(...arguments),this.checked=void 0}render(){return i.html`
      <button>
        <wui-icon size="xl" name="walletConnectBrown"></wui-icon>
        <wui-switch ?checked=${(0,r.ifDefined)(this.checked)}></wui-switch>
      </button>
    `}};s.styles=[o.resetStyles,o.elementStyles,l.default],d([(0,c.property)({type:Boolean})],s.prototype,"checked",void 0),e.WuiCertifiedSwitch=s=d([(0,n.customElement)('wui-certified-switch')],s)},7001,[2,4951,4960,4974,4976,4950,4959,7002,7006]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.WuiSwitch=void 0;var c=_r(_d[1]),i=_r(_d[2]),n=_r(_d[3]),s=_r(_d[4]),l=_r(_d[5]),o=_r(_d[6]),r=t(_r(_d[7])),h=this&&this.__decorate||function(t,c,i,n){var s,l=arguments.length,o=l<3?c:null===n?n=Object.getOwnPropertyDescriptor(c,i):n;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)o=Reflect.decorate(t,c,i,n);else for(var r=t.length-1;r>=0;r--)(s=t[r])&&(o=(l<3?s(o):l>3?s(c,i,o):s(c,i))||o);return l>3&&o&&Object.defineProperty(c,i,o),o};let d=e.WuiSwitch=class extends c.LitElement{constructor(){super(...arguments),this.inputElementRef=(0,s.createRef)(),this.checked=void 0}render(){return c.html`
      <label>
        <input
          ${(0,s.ref)(this.inputElementRef)}
          type="checkbox"
          ?checked=${(0,n.ifDefined)(this.checked)}
          @change=${this.dispatchChangeEvent.bind(this)}
        />
        <span></span>
      </label>
    `}dispatchChangeEvent(){this.dispatchEvent(new CustomEvent('switchChange',{detail:this.inputElementRef.value?.checked,bubbles:!0,composed:!0}))}};d.styles=[l.resetStyles,l.elementStyles,l.colorStyles,r.default],h([(0,i.property)({type:Boolean})],d.prototype,"checked",void 0),e.WuiSwitch=d=h([(0,o.customElement)('wui-switch')],d)},7002,[2,4951,4960,4974,7003,4950,4959,7005]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0});var n=r(d[0]);Object.keys(n).forEach(function(t){"default"!==t&&"__esModule"!==t&&(t in e&&e[t]===n[t]||Object.defineProperty(e,t,{enumerable:!0,get:function(){return n[t]}}))})},7003,[7004]);
__d(function(g,r,_i,a,m,_e,d){Object.defineProperty(_e,"__esModule",{value:!0}),_e.ref=_e.createRef=void 0;var t=r(d[0]),e=r(d[1]),i=r(d[2]);_e.createRef=()=>new s;class s{}const h=new WeakMap;_e.ref=(0,i.directive)(class extends e.AsyncDirective{render(e){return t.nothing}update(e,[i]){const s=i!==this.G;return s&&this.rt(void 0),(s||this.lt!==this.ct)&&(this.G=i,this.ht=e.options?.host,this.rt(this.ct=e.element)),t.nothing}rt(t){if(void 0!==this.G)if(this.isConnected||(t=void 0),"function"==typeof this.G){const e=this.ht??globalThis;let i=h.get(e);void 0===i&&(i=new WeakMap,h.set(e,i)),void 0!==i.get(this.G)&&this.G.call(this.ht,void 0),i.set(this.G,t),void 0!==t&&this.G.call(this.ht,t)}else this.G.value=t}get lt(){return"function"==typeof this.G?h.get(this.ht??globalThis)?.get(this.G):this.G?.value}disconnected(){this.lt===this.ct&&this.rt(void 0)}reconnected(){this.rt(this.ct)}})},7004,[4954,4980,4981]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var o=r(d[0]);e.default=o.css`
  :host {
    display: flex;
    align-items: center;
    justify-content: center;
  }

  label {
    position: relative;
    display: inline-block;
    width: 32px;
    height: 22px;
  }

  input {
    width: 0;
    height: 0;
    opacity: 0;
  }

  span {
    position: absolute;
    cursor: pointer;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background-color: var(--wui-color-blue-100);
    border-width: 1px;
    border-style: solid;
    border-color: var(--wui-color-gray-glass-002);
    border-radius: 999px;
    transition:
      background-color var(--wui-ease-inout-power-1) var(--wui-duration-md),
      border-color var(--wui-ease-inout-power-1) var(--wui-duration-md);
    will-change: background-color, border-color;
  }

  span:before {
    position: absolute;
    content: '';
    height: 16px;
    width: 16px;
    left: 3px;
    top: 2px;
    background-color: var(--wui-color-inverse-100);
    transition: transform var(--wui-ease-inout-power-1) var(--wui-duration-lg);
    will-change: transform;
    border-radius: 50%;
  }

  input:checked + span {
    border-color: var(--wui-color-gray-glass-005);
    background-color: var(--wui-color-blue-100);
  }

  input:not(:checked) + span {
    background-color: var(--wui-color-gray-glass-010);
  }

  input:checked + span:before {
    transform: translateX(calc(100% - 7px));
  }
`},7005,[4951]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var o=r(d[0]);e.default=o.css`
  :host {
    height: 100%;
  }

  button {
    display: flex;
    align-items: center;
    justify-content: center;
    column-gap: var(--wui-spacing-1xs);
    padding: var(--wui-spacing-xs) var(--wui-spacing-s);
    background-color: var(--wui-color-gray-glass-002);
    border-radius: var(--wui-border-radius-xs);
    box-shadow: inset 0 0 0 1px var(--wui-color-gray-glass-002);
    transition: background-color var(--wui-ease-out-power-1) var(--wui-duration-md);
    will-change: background-color;
    cursor: pointer;
  }

  wui-switch {
    pointer-events: none;
  }
`},7006,[4951]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0});var n=r(d[0]);Object.keys(n).forEach(function(t){"default"!==t&&"__esModule"!==t&&(t in e&&e[t]===n[t]||Object.defineProperty(e,t,{enumerable:!0,get:function(){return n[t]}}))})},7007,[7008]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.WuiSearchBar=void 0;var r=_r(_d[1]),n=_r(_d[2]);_r(_d[3]);var c=_r(_d[4]),i=_r(_d[5]);_r(_d[6]);var u=t(_r(_d[7])),l=this&&this.__decorate||function(t,r,n,c){var i,u=arguments.length,l=u<3?r:null===c?c=Object.getOwnPropertyDescriptor(r,n):c;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)l=Reflect.decorate(t,r,n,c);else for(var o=t.length-1;o>=0;o--)(i=t[o])&&(l=(u<3?i(l):u>3?i(r,n,l):i(r,n))||l);return u>3&&l&&Object.defineProperty(r,n,l),l};let o=e.WuiSearchBar=class extends r.LitElement{constructor(){super(...arguments),this.inputComponentRef=(0,n.createRef)()}render(){return r.html`
      <wui-input-text
        ${(0,n.ref)(this.inputComponentRef)}
        placeholder="Search wallet"
        icon="search"
        type="search"
        enterKeyHint="search"
        size="sm"
      >
        <wui-input-element @click=${this.clearValue} icon="close"></wui-input-element>
      </wui-input-text>
    `}clearValue(){const t=this.inputComponentRef.value,r=t?.inputElementRef.value;r&&(r.value='',r.focus(),r.dispatchEvent(new Event('input')))}};o.styles=[c.resetStyles,u.default],e.WuiSearchBar=o=l([(0,i.customElement)('wui-search-bar')],o)},7008,[2,4951,7003,7009,4950,4959,7011,7013]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.WuiInputElement=void 0;var n=_r(_d[1]),o=_r(_d[2]);_r(_d[3]);var r=_r(_d[4]),i=_r(_d[5]),c=t(_r(_d[6])),l=this&&this.__decorate||function(t,n,o,r){var i,c=arguments.length,l=c<3?n:null===r?r=Object.getOwnPropertyDescriptor(n,o):r;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)l=Reflect.decorate(t,n,o,r);else for(var u=t.length-1;u>=0;u--)(i=t[u])&&(l=(c<3?i(l):c>3?i(n,o,l):i(n,o))||l);return c>3&&l&&Object.defineProperty(n,o,l),l};let u=e.WuiInputElement=class extends n.LitElement{constructor(){super(...arguments),this.icon='copy'}render(){return n.html`
      <button>
        <wui-icon color="inherit" size="xxs" name=${this.icon}></wui-icon>
      </button>
    `}};u.styles=[r.resetStyles,r.elementStyles,c.default],l([(0,o.property)()],u.prototype,"icon",void 0),e.WuiInputElement=u=l([(0,i.customElement)('wui-input-element')],u)},7009,[2,4951,4960,4976,4950,4959,7010]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var o=r(d[0]);e.default=o.css`
  button {
    background-color: var(--wui-color-fg-300);
    border-radius: var(--wui-border-radius-4xs);
    width: 16px;
    height: 16px;
  }

  button:disabled {
    background-color: var(--wui-color-bg-300);
  }

  wui-icon {
    color: var(--wui-color-bg-200) !important;
  }

  button:focus-visible {
    background-color: var(--wui-color-fg-250);
    border: 1px solid var(--wui-color-accent-100);
  }

  @media (hover: hover) and (pointer: fine) {
    button:hover:enabled {
      background-color: var(--wui-color-fg-250);
    }

    button:active:enabled {
      background-color: var(--wui-color-fg-225);
    }
  }
`},7010,[4951]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.WuiInputText=void 0;var i=_r(_d[1]),o=_r(_d[2]),p=_r(_d[3]),n=_r(_d[4]),r=_r(_d[5]);_r(_d[6]);var s=_r(_d[7]),d=_r(_d[8]),l=t(_r(_d[9])),u=this&&this.__decorate||function(t,i,o,p){var n,r=arguments.length,s=r<3?i:null===p?p=Object.getOwnPropertyDescriptor(i,o):p;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)s=Reflect.decorate(t,i,o,p);else for(var d=t.length-1;d>=0;d--)(n=t[d])&&(s=(r<3?n(s):r>3?n(i,o,s):n(i,o))||s);return r>3&&s&&Object.defineProperty(i,o,s),s};let h=e.WuiInputText=class extends i.LitElement{constructor(){super(...arguments),this.inputElementRef=(0,r.createRef)(),this.size='md',this.disabled=!1,this.placeholder='',this.type='text',this.value=''}render(){const t=`wui-padding-right-${this.inputRightPadding}`,o=`wui-size-${this.size}`,s={[o]:!0,[t]:Boolean(this.inputRightPadding)};return i.html`${this.templateIcon()}
      <input
        data-testid="wui-input-text"
        ${(0,r.ref)(this.inputElementRef)}
        class=${(0,p.classMap)(s)}
        type=${this.type}
        enterkeyhint=${(0,n.ifDefined)(this.enterKeyHint)}
        ?disabled=${this.disabled}
        placeholder=${this.placeholder}
        @input=${this.dispatchInputChangeEvent.bind(this)}
        .value=${this.value||''}
        tabindex=${(0,n.ifDefined)(this.tabIdx)}
      />
      <slot></slot>`}templateIcon(){return this.icon?i.html`<wui-icon
        data-input=${this.size}
        size=${this.size}
        color="inherit"
        name=${this.icon}
      ></wui-icon>`:null}dispatchInputChangeEvent(){this.dispatchEvent(new CustomEvent('inputChange',{detail:this.inputElementRef.value?.value,bubbles:!0,composed:!0}))}};h.styles=[s.resetStyles,s.elementStyles,l.default],u([(0,o.property)()],h.prototype,"size",void 0),u([(0,o.property)()],h.prototype,"icon",void 0),u([(0,o.property)({type:Boolean})],h.prototype,"disabled",void 0),u([(0,o.property)()],h.prototype,"placeholder",void 0),u([(0,o.property)()],h.prototype,"type",void 0),u([(0,o.property)()],h.prototype,"keyHint",void 0),u([(0,o.property)()],h.prototype,"value",void 0),u([(0,o.property)()],h.prototype,"inputRightPadding",void 0),u([(0,o.property)()],h.prototype,"tabIdx",void 0),e.WuiInputText=h=u([(0,d.customElement)('wui-input-text')],h)},7011,[2,4951,4960,4986,4974,7003,4976,4950,4959,7012]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var n=r(d[0]);e.default=n.css`
  :host {
    position: relative;
    width: 100%;
    display: inline-block;
    color: var(--wui-color-fg-275);
  }

  input {
    width: 100%;
    border-radius: var(--wui-border-radius-xs);
    box-shadow: inset 0 0 0 1px var(--wui-color-gray-glass-002);
    background: var(--wui-color-gray-glass-002);
    font-size: var(--wui-font-size-paragraph);
    letter-spacing: var(--wui-letter-spacing-paragraph);
    color: var(--wui-color-fg-100);
    transition:
      background-color var(--wui-ease-inout-power-1) var(--wui-duration-md),
      border-color var(--wui-ease-inout-power-1) var(--wui-duration-md),
      box-shadow var(--wui-ease-inout-power-1) var(--wui-duration-md);
    will-change: background-color, border-color, box-shadow;
    caret-color: var(--wui-color-accent-100);
  }

  input:disabled {
    cursor: not-allowed;
    border: 1px solid var(--wui-color-gray-glass-010);
  }

  input:disabled::placeholder,
  input:disabled + wui-icon {
    color: var(--wui-color-fg-300);
  }

  input::placeholder {
    color: var(--wui-color-fg-275);
  }

  input:focus:enabled {
    background-color: var(--wui-color-gray-glass-005);
    -webkit-box-shadow:
      inset 0 0 0 1px var(--wui-color-accent-100),
      0px 0px 0px 4px var(--wui-box-shadow-blue);
    -moz-box-shadow:
      inset 0 0 0 1px var(--wui-color-accent-100),
      0px 0px 0px 4px var(--wui-box-shadow-blue);
    box-shadow:
      inset 0 0 0 1px var(--wui-color-accent-100),
      0px 0px 0px 4px var(--wui-box-shadow-blue);
  }

  input:hover:enabled {
    background-color: var(--wui-color-gray-glass-005);
  }

  wui-icon {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    pointer-events: none;
  }

  .wui-size-sm {
    padding: 9px var(--wui-spacing-m) 10px var(--wui-spacing-s);
  }

  wui-icon + .wui-size-sm {
    padding: 9px var(--wui-spacing-m) 10px 36px;
  }

  wui-icon[data-input='sm'] {
    left: var(--wui-spacing-s);
  }

  .wui-size-md {
    padding: 15px var(--wui-spacing-m) var(--wui-spacing-l) var(--wui-spacing-m);
  }

  wui-icon + .wui-size-md,
  wui-loading-spinner + .wui-size-md {
    padding: 10.5px var(--wui-spacing-3xl) 10.5px var(--wui-spacing-3xl);
  }

  wui-icon[data-input='md'] {
    left: var(--wui-spacing-l);
  }

  .wui-size-lg {
    padding: var(--wui-spacing-s) var(--wui-spacing-s) var(--wui-spacing-s) var(--wui-spacing-l);
    letter-spacing: var(--wui-letter-spacing-medium-title);
    font-size: var(--wui-font-size-medium-title);
    font-weight: var(--wui-font-weight-light);
    line-height: 130%;
    color: var(--wui-color-fg-100);
    height: 64px;
  }

  .wui-padding-right-xs {
    padding-right: var(--wui-spacing-xs);
  }

  .wui-padding-right-s {
    padding-right: var(--wui-spacing-s);
  }

  .wui-padding-right-m {
    padding-right: var(--wui-spacing-m);
  }

  .wui-padding-right-l {
    padding-right: var(--wui-spacing-l);
  }

  .wui-padding-right-xl {
    padding-right: var(--wui-spacing-xl);
  }

  .wui-padding-right-2xl {
    padding-right: var(--wui-spacing-2xl);
  }

  .wui-padding-right-3xl {
    padding-right: var(--wui-spacing-3xl);
  }

  .wui-padding-right-4xl {
    padding-right: var(--wui-spacing-4xl);
  }

  .wui-padding-right-5xl {
    padding-right: var(--wui-spacing-5xl);
  }

  wui-icon + .wui-size-lg,
  wui-loading-spinner + .wui-size-lg {
    padding-left: 50px;
  }

  wui-icon[data-input='lg'] {
    left: var(--wui-spacing-l);
  }

  .wui-size-mdl {
    padding: 17.25px var(--wui-spacing-m) 17.25px var(--wui-spacing-m);
  }
  wui-icon + .wui-size-mdl,
  wui-loading-spinner + .wui-size-mdl {
    padding: 17.25px var(--wui-spacing-3xl) 17.25px 40px;
  }
  wui-icon[data-input='mdl'] {
    left: var(--wui-spacing-m);
  }

  input:placeholder-shown ~ ::slotted(wui-input-element),
  input:placeholder-shown ~ ::slotted(wui-icon) {
    opacity: 0;
    pointer-events: none;
  }

  input::-webkit-outer-spin-button,
  input::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }

  input[type='number'] {
    -moz-appearance: textfield;
  }

  ::slotted(wui-input-element),
  ::slotted(wui-icon) {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
  }

  ::slotted(wui-input-element) {
    right: var(--wui-spacing-m);
  }

  ::slotted(wui-icon) {
    right: 0px;
  }
`},7012,[4951]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var t=r(d[0]);e.default=t.css`
  :host {
    position: relative;
    display: inline-block;
    width: 100%;
  }
`},7013,[4951]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.W3mAllWalletsList=void 0;var l=_r(_d[1]),i=_r(_d[2]),s=_r(_d[3]),r=_r(_d[4]),o=_r(_d[5]);_r(_d[6]),_r(_d[7]);var n=_r(_d[8]);_r(_d[9]);var d=t(_r(_d[10])),c=this&&this.__decorate||function(t,l,i,s){var r,o=arguments.length,n=o<3?l:null===s?s=Object.getOwnPropertyDescriptor(l,i):s;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)n=Reflect.decorate(t,l,i,s);else for(var d=t.length-1;d>=0;d--)(r=t[d])&&(n=(o<3?r(n):o>3?r(l,i,n):r(l,i))||n);return o>3&&n&&Object.defineProperty(l,i,n),n};const h='local-paginator';let p=e.W3mAllWalletsList=class extends l.LitElement{constructor(){super(),this.unsubscribe=[],this.paginationObserver=void 0,this.loading=!r.ApiController.state.wallets.length,this.wallets=r.ApiController.state.wallets,this.recommended=r.ApiController.state.recommended,this.featured=r.ApiController.state.featured,this.filteredWallets=r.ApiController.state.filteredWallets,this.unsubscribe.push(r.ApiController.subscribeKey('wallets',t=>this.wallets=t),r.ApiController.subscribeKey('recommended',t=>this.recommended=t),r.ApiController.subscribeKey('featured',t=>this.featured=t),r.ApiController.subscribeKey('filteredWallets',t=>this.filteredWallets=t))}firstUpdated(){this.initialFetch(),this.createPaginationObserver()}disconnectedCallback(){this.unsubscribe.forEach(t=>t()),this.paginationObserver?.disconnect()}render(){return l.html`
      <wui-grid
        data-scroll=${!this.loading}
        .padding=${['0','s','s','s']}
        columnGap="xxs"
        rowGap="l"
        justifyContent="space-between"
      >
        ${this.loading?this.shimmerTemplate(16):this.walletsTemplate()}
        ${this.paginationLoaderTemplate()}
      </wui-grid>
    `}async initialFetch(){this.loading=!0;const t=this.shadowRoot?.querySelector('wui-grid');t&&(await r.ApiController.fetchWalletsByPage({page:1}),await t.animate([{opacity:1},{opacity:0}],{duration:200,fill:'forwards',easing:'ease'}).finished,this.loading=!1,t.animate([{opacity:0},{opacity:1}],{duration:200,fill:'forwards',easing:'ease'}))}shimmerTemplate(t,i){return[...Array(t)].map(()=>l.html`
        <wui-card-select-loader type="wallet" id=${(0,s.ifDefined)(i)}></wui-card-select-loader>
      `)}walletsTemplate(){const t=this.filteredWallets?.length>0?r.CoreHelperUtil.uniqueBy([...this.featured,...this.recommended,...this.filteredWallets],'id'):r.CoreHelperUtil.uniqueBy([...this.featured,...this.recommended,...this.wallets],'id');return n.WalletUtil.markWalletsAsInstalled(t).map(t=>l.html`
        <w3m-all-wallets-list-item
          @click=${()=>this.onConnectWallet(t)}
          .wallet=${t}
        ></w3m-all-wallets-list-item>
      `)}paginationLoaderTemplate(){const{wallets:t,recommended:l,featured:i,count:s}=r.ApiController.state,o=window.innerWidth<352?3:4,n=t.length+l.length;let d=Math.ceil(n/o)*o-n+o;return d-=t.length?i.length%o:0,0===s&&i.length>0?null:0===s||[...i,...t,...l].length<s?this.shimmerTemplate(d,h):null}createPaginationObserver(){const t=this.shadowRoot?.querySelector(`#${h}`);t&&(this.paginationObserver=new IntersectionObserver(([t])=>{if(t?.isIntersecting&&!this.loading){const{page:t,count:l,wallets:i}=r.ApiController.state;i.length<l&&r.ApiController.fetchWalletsByPage({page:t+1})}}),this.paginationObserver.observe(t))}onConnectWallet(t){r.ConnectorController.selectWalletConnector(t)}};p.styles=d.default,c([(0,i.state)()],p.prototype,"loading",void 0),c([(0,i.state)()],p.prototype,"wallets",void 0),c([(0,i.state)()],p.prototype,"recommended",void 0),c([(0,i.state)()],p.prototype,"featured",void 0),c([(0,i.state)()],p.prototype,"filteredWallets",void 0),e.W3mAllWalletsList=p=c([(0,o.customElement)('w3m-all-wallets-list')],p)},7014,[2,4951,4960,4974,4631,4948,7015,7019,4946,7022,7024]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0});var n=r(d[0]);Object.keys(n).forEach(function(t){"default"!==t&&"__esModule"!==t&&(t in e&&e[t]===n[t]||Object.defineProperty(e,t,{enumerable:!0,get:function(){return n[t]}}))})},7015,[7016]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.WuiCardSelectLoader=void 0;var r=_r(_d[1]),i=_r(_d[2]),s=_r(_d[3]);_r(_d[4]);var o=_r(_d[5]),d=_r(_d[6]),l=t(_r(_d[7])),h=this&&this.__decorate||function(t,r,i,s){var o,d=arguments.length,l=d<3?r:null===s?s=Object.getOwnPropertyDescriptor(r,i):s;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)l=Reflect.decorate(t,r,i,s);else for(var h=t.length-1;h>=0;h--)(o=t[h])&&(l=(d<3?o(l):d>3?o(r,i,l):o(r,i))||l);return d>3&&l&&Object.defineProperty(r,i,l),l};let u=e.WuiCardSelectLoader=class extends r.LitElement{constructor(){super(...arguments),this.type='wallet'}render(){return r.html`
      ${this.shimmerTemplate()}
      <wui-shimmer width="56px" height="20px" borderRadius="xs"></wui-shimmer>
    `}shimmerTemplate(){return'network'===this.type?r.html` <wui-shimmer
          data-type=${this.type}
          width="48px"
          height="54px"
          borderRadius="xs"
        ></wui-shimmer>
        ${s.networkSvgMd}`:r.html`<wui-shimmer width="56px" height="56px" borderRadius="xs"></wui-shimmer>`}};u.styles=[o.resetStyles,o.elementStyles,l.default],h([(0,i.property)()],u.prototype,"type",void 0),e.WuiCardSelectLoader=u=h([(0,d.customElement)('wui-card-select-loader')],u)},7016,[2,4951,4960,7017,6990,4950,4959,7018]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.networkSvgMd=void 0;var v=r(d[0]);e.networkSvgMd=v.svg`<svg  viewBox="0 0 48 54" fill="none">
  <path
    d="M43.4605 10.7248L28.0485 1.61089C25.5438 0.129705 22.4562 0.129705 19.9515 1.61088L4.53951 10.7248C2.03626 12.2051 0.5 14.9365 0.5 17.886V36.1139C0.5 39.0635 2.03626 41.7949 4.53951 43.2752L19.9515 52.3891C22.4562 53.8703 25.5438 53.8703 28.0485 52.3891L43.4605 43.2752C45.9637 41.7949 47.5 39.0635 47.5 36.114V17.8861C47.5 14.9365 45.9637 12.2051 43.4605 10.7248Z"
  />
</svg>`},7017,[4951]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var t=r(d[0]);e.default=t.css`
  :host {
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 104px;
    row-gap: var(--wui-spacing-xs);
    padding: var(--wui-spacing-xs) 10px;
    background-color: var(--wui-color-gray-glass-002);
    border-radius: clamp(0px, var(--wui-border-radius-xs), 20px);
    position: relative;
  }

  wui-shimmer[data-type='network'] {
    border: none;
    -webkit-clip-path: var(--wui-path-network);
    clip-path: var(--wui-path-network);
  }

  svg {
    position: absolute;
    width: 48px;
    height: 54px;
    z-index: 1;
  }

  svg > path {
    stroke: var(--wui-color-gray-glass-010);
    stroke-width: 1px;
  }

  @media (max-width: 350px) {
    :host {
      width: 100%;
    }
  }
`},7018,[4951]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0});var n=r(d[0]);Object.keys(n).forEach(function(t){"default"!==t&&"__esModule"!==t&&(t in e&&e[t]===n[t]||Object.defineProperty(e,t,{enumerable:!0,get:function(){return n[t]}}))})},7019,[7020]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.WuiGrid=void 0;var i=_r(_d[1]),p=_r(_d[2]),n=_r(_d[3]),r=_r(_d[4]),o=_r(_d[5]),s=t(_r(_d[6])),l=this&&this.__decorate||function(t,i,p,n){var r,o=arguments.length,s=o<3?i:null===n?n=Object.getOwnPropertyDescriptor(i,p):n;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)s=Reflect.decorate(t,i,p,n);else for(var l=t.length-1;l>=0;l--)(r=t[l])&&(s=(o<3?r(s):o>3?r(i,p,s):r(i,p))||s);return o>3&&s&&Object.defineProperty(i,p,s),s};let d=e.WuiGrid=class extends i.LitElement{render(){return this.style.cssText=`\n      grid-template-rows: ${this.gridTemplateRows};\n      grid-template-columns: ${this.gridTemplateColumns};\n      justify-items: ${this.justifyItems};\n      align-items: ${this.alignItems};\n      justify-content: ${this.justifyContent};\n      align-content: ${this.alignContent};\n      column-gap: ${this.columnGap&&`var(--wui-spacing-${this.columnGap})`};\n      row-gap: ${this.rowGap&&`var(--wui-spacing-${this.rowGap})`};\n      gap: ${this.gap&&`var(--wui-spacing-${this.gap})`};\n      padding-top: ${this.padding&&r.UiHelperUtil.getSpacingStyles(this.padding,0)};\n      padding-right: ${this.padding&&r.UiHelperUtil.getSpacingStyles(this.padding,1)};\n      padding-bottom: ${this.padding&&r.UiHelperUtil.getSpacingStyles(this.padding,2)};\n      padding-left: ${this.padding&&r.UiHelperUtil.getSpacingStyles(this.padding,3)};\n      margin-top: ${this.margin&&r.UiHelperUtil.getSpacingStyles(this.margin,0)};\n      margin-right: ${this.margin&&r.UiHelperUtil.getSpacingStyles(this.margin,1)};\n      margin-bottom: ${this.margin&&r.UiHelperUtil.getSpacingStyles(this.margin,2)};\n      margin-left: ${this.margin&&r.UiHelperUtil.getSpacingStyles(this.margin,3)};\n    `,i.html`<slot></slot>`}};d.styles=[n.resetStyles,s.default],l([(0,p.property)()],d.prototype,"gridTemplateRows",void 0),l([(0,p.property)()],d.prototype,"gridTemplateColumns",void 0),l([(0,p.property)()],d.prototype,"justifyItems",void 0),l([(0,p.property)()],d.prototype,"alignItems",void 0),l([(0,p.property)()],d.prototype,"justifyContent",void 0),l([(0,p.property)()],d.prototype,"alignContent",void 0),l([(0,p.property)()],d.prototype,"columnGap",void 0),l([(0,p.property)()],d.prototype,"rowGap",void 0),l([(0,p.property)()],d.prototype,"gap",void 0),l([(0,p.property)()],d.prototype,"padding",void 0),l([(0,p.property)()],d.prototype,"margin",void 0),e.WuiGrid=d=l([(0,o.customElement)('wui-grid')],d)},7020,[2,4951,4960,4950,4957,4959,7021]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var t=r(d[0]);e.default=t.css`
  :host {
    display: grid;
    width: inherit;
    height: inherit;
  }
`},7021,[4951]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.W3mAllWalletsListItem=void 0;var i=_r(_d[1]),s=_r(_d[2]),l=_r(_d[3]),r=_r(_d[4]),n=_r(_d[5]);_r(_d[6]),_r(_d[7]),_r(_d[8]),_r(_d[9]),_r(_d[10]);var o=t(_r(_d[11])),c=this&&this.__decorate||function(t,i,s,l){var r,n=arguments.length,o=n<3?i:null===l?l=Object.getOwnPropertyDescriptor(i,s):l;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)o=Reflect.decorate(t,i,s,l);else for(var c=t.length-1;c>=0;c--)(r=t[c])&&(o=(n<3?r(o):n>3?r(i,s,o):r(i,s))||o);return n>3&&o&&Object.defineProperty(i,s,o),o};let h=e.W3mAllWalletsListItem=class extends i.LitElement{constructor(){super(),this.observer=new IntersectionObserver(()=>{}),this.visible=!1,this.imageSrc=void 0,this.imageLoading=!1,this.wallet=void 0,this.observer=new IntersectionObserver(t=>{t.forEach(t=>{t.isIntersecting?(this.visible=!0,this.fetchImageSrc()):this.visible=!1})},{threshold:.01})}firstUpdated(){this.observer.observe(this)}disconnectedCallback(){this.observer.disconnect()}render(){const t='certified'===this.wallet?.badge_type;return i.html`
      <button>
        ${this.imageTemplate()}
        <wui-flex flexDirection="row" alignItems="center" justifyContent="center" gap="3xs">
          <wui-text
            variant="tiny-500"
            color="inherit"
            class=${(0,l.ifDefined)(t?'certified':void 0)}
            >${this.wallet?.name}</wui-text
          >
          ${t?i.html`<wui-icon size="sm" name="walletConnectBrown"></wui-icon>`:null}
        </wui-flex>
      </button>
    `}imageTemplate(){return!this.visible&&!this.imageSrc||this.imageLoading?this.shimmerTemplate():i.html`
      <wui-wallet-image
        size="md"
        imageSrc=${(0,l.ifDefined)(this.imageSrc)}
        name=${this.wallet?.name}
        .installed=${this.wallet?.installed}
        badgeSize="sm"
      >
      </wui-wallet-image>
    `}shimmerTemplate(){return i.html`<wui-shimmer width="56px" height="56px" borderRadius="xs"></wui-shimmer>`}async fetchImageSrc(){this.wallet&&(this.imageSrc=r.AssetUtil.getWalletImage(this.wallet),this.imageSrc||(this.imageLoading=!0,this.imageSrc=await r.AssetUtil.fetchWalletImage(this.wallet.image_id),this.imageLoading=!1))}};h.styles=o.default,c([(0,s.state)()],h.prototype,"visible",void 0),c([(0,s.state)()],h.prototype,"imageSrc",void 0),c([(0,s.state)()],h.prototype,"imageLoading",void 0),c([(0,s.property)()],h.prototype,"wallet",void 0),e.W3mAllWalletsListItem=h=c([(0,n.customElement)('w3m-all-wallets-list-item')],h)},7022,[2,4951,4960,4974,4631,4948,4971,4997,6989,4998,6945,7023]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var o=r(d[0]);e.default=o.css`
  button {
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    cursor: pointer;
    width: 104px;
    row-gap: var(--wui-spacing-xs);
    padding: var(--wui-spacing-s) var(--wui-spacing-0);
    background-color: var(--wui-color-gray-glass-002);
    border-radius: clamp(0px, var(--wui-border-radius-xs), 20px);
    transition:
      color var(--wui-duration-lg) var(--wui-ease-out-power-1),
      background-color var(--wui-duration-lg) var(--wui-ease-out-power-1),
      border-radius var(--wui-duration-lg) var(--wui-ease-out-power-1);
    will-change: background-color, color, border-radius;
    outline: none;
    border: none;
  }

  button > wui-flex > wui-text {
    color: var(--wui-color-fg-100);
    max-width: 86px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    justify-content: center;
  }

  button > wui-flex > wui-text.certified {
    max-width: 66px;
  }

  button:hover:enabled {
    background-color: var(--wui-color-gray-glass-005);
  }

  button:disabled > wui-flex > wui-text {
    color: var(--wui-color-gray-glass-015);
  }

  [data-selected='true'] {
    background-color: var(--wui-color-accent-glass-020);
  }

  @media (hover: hover) and (pointer: fine) {
    [data-selected='true']:hover:enabled {
      background-color: var(--wui-color-accent-glass-015);
    }
  }

  [data-selected='true']:active:enabled {
    background-color: var(--wui-color-accent-glass-010);
  }

  @media (max-width: 350px) {
    button {
      width: 100%;
    }
  }
`},7023,[4951]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var l=r(d[0]);e.default=l.css`
  wui-grid {
    max-height: clamp(360px, 400px, 80vh);
    overflow: scroll;
    scrollbar-width: none;
    grid-auto-rows: min-content;
    grid-template-columns: repeat(auto-fill, 104px);
  }

  @media (max-width: 350px) {
    wui-grid {
      grid-template-columns: repeat(2, 1fr);
    }
  }

  wui-grid[data-scroll='false'] {
    overflow: hidden;
  }

  wui-grid::-webkit-scrollbar {
    display: none;
  }

  wui-loading-spinner {
    padding-top: var(--wui-spacing-l);
    padding-bottom: var(--wui-spacing-l);
    justify-content: center;
    grid-column: 1 / span 4;
  }
`},7024,[4951]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.W3mAllWalletsSearch=void 0;var l=_r(_d[1]),r=_r(_d[2]),i=_r(_d[3]),o=_r(_d[4]);_r(_d[5]),_r(_d[6]),_r(_d[7]),_r(_d[8]),_r(_d[9]);var n=_r(_d[10]);_r(_d[11]);var s=t(_r(_d[12])),c=this&&this.__decorate||function(t,l,r,i){var o,n=arguments.length,s=n<3?l:null===i?i=Object.getOwnPropertyDescriptor(l,r):i;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)s=Reflect.decorate(t,l,r,i);else for(var c=t.length-1;c>=0;c--)(o=t[c])&&(s=(n<3?o(s):n>3?o(l,r,s):o(l,r))||s);return n>3&&s&&Object.defineProperty(l,r,s),s};let d=e.W3mAllWalletsSearch=class extends l.LitElement{constructor(){super(...arguments),this.prevQuery='',this.prevBadge=void 0,this.loading=!0,this.query=''}render(){return this.onSearch(),this.loading?l.html`<wui-loading-spinner color="accent-100"></wui-loading-spinner>`:this.walletsTemplate()}async onSearch(){this.query.trim()===this.prevQuery.trim()&&this.badge===this.prevBadge||(this.prevQuery=this.query,this.prevBadge=this.badge,this.loading=!0,await i.ApiController.searchWallet({search:this.query,badge:this.badge}),this.loading=!1)}walletsTemplate(){const{search:t}=i.ApiController.state,r=n.WalletUtil.markWalletsAsInstalled(t);return t.length?l.html`
      <wui-grid
        data-testid="wallet-list"
        .padding=${['0','s','s','s']}
        rowGap="l"
        columnGap="xs"
        justifyContent="space-between"
      >
        ${r.map(t=>l.html`
            <w3m-all-wallets-list-item
              @click=${()=>this.onConnectWallet(t)}
              .wallet=${t}
              data-testid="wallet-search-item-${t.id}"
            ></w3m-all-wallets-list-item>
          `)}
      </wui-grid>
    `:l.html`
        <wui-flex
          data-testid="no-wallet-found"
          justifyContent="center"
          alignItems="center"
          gap="s"
          flexDirection="column"
        >
          <wui-icon-box
            size="lg"
            iconColor="fg-200"
            backgroundColor="fg-300"
            icon="wallet"
            background="transparent"
          ></wui-icon-box>
          <wui-text data-testid="no-wallet-found-text" color="fg-200" variant="paragraph-500">
            No Wallet found
          </wui-text>
        </wui-flex>
      `}onConnectWallet(t){i.ConnectorController.selectWalletConnector(t)}};d.styles=s.default,c([(0,r.state)()],d.prototype,"loading",void 0),c([(0,r.property)()],d.prototype,"query",void 0),c([(0,r.property)()],d.prototype,"badge",void 0),e.W3mAllWalletsSearch=d=c([(0,o.customElement)('w3m-all-wallets-search')],d)},7025,[2,4951,4960,4631,4948,4971,7019,6938,7026,4998,4946,7022,7027]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0});var n=r(d[0]);Object.keys(n).forEach(function(t){"default"!==t&&"__esModule"!==t&&(t in e&&e[t]===n[t]||Object.defineProperty(e,t,{enumerable:!0,get:function(){return n[t]}}))})},7026,[4995]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var l=r(d[0]);e.default=l.css`
  wui-grid,
  wui-loading-spinner,
  wui-flex {
    height: 360px;
  }

  wui-grid {
    overflow: scroll;
    scrollbar-width: none;
    grid-auto-rows: min-content;
    grid-template-columns: repeat(auto-fill, 104px);
  }

  wui-grid[data-scroll='false'] {
    overflow: hidden;
  }

  wui-grid::-webkit-scrollbar {
    display: none;
  }

  wui-loading-spinner {
    justify-content: center;
    align-items: center;
  }

  @media (max-width: 350px) {
    wui-grid {
      grid-template-columns: repeat(2, 1fr);
    }
  }
`},7027,[4951]);
__d(function(g,_r,_i,a,m,e,_d){Object.defineProperty(e,"__esModule",{value:!0}),e.W3mDownloadsView=void 0;var t=_r(_d[0]),i=_r(_d[1]),o=_r(_d[2]);_r(_d[3]),_r(_d[4]),_r(_d[5]);var r=this&&this.__decorate||function(t,i,o,r){var l,n=arguments.length,s=n<3?i:null===r?r=Object.getOwnPropertyDescriptor(i,o):r;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)s=Reflect.decorate(t,i,o,r);else for(var h=t.length-1;h>=0;h--)(l=t[h])&&(s=(n<3?l(s):n>3?l(i,o,s):l(i,o))||s);return n>3&&s&&Object.defineProperty(i,o,s),s};let l=e.W3mDownloadsView=class extends t.LitElement{constructor(){super(...arguments),this.wallet=i.RouterController.state.data?.wallet}render(){if(!this.wallet)throw new Error('w3m-downloads-view');return t.html`
      <wui-flex gap="xs" flexDirection="column" .padding=${['s','s','l','s']}>
        ${this.chromeTemplate()} ${this.iosTemplate()} ${this.androidTemplate()}
        ${this.homepageTemplate()}
      </wui-flex>
    `}chromeTemplate(){return this.wallet?.chrome_store?t.html`<wui-list-item
      variant="icon"
      icon="chromeStore"
      iconVariant="square"
      @click=${this.onChromeStore.bind(this)}
      chevron
    >
      <wui-text variant="paragraph-500" color="fg-100">Chrome Extension</wui-text>
    </wui-list-item>`:null}iosTemplate(){return this.wallet?.app_store?t.html`<wui-list-item
      variant="icon"
      icon="appStore"
      iconVariant="square"
      @click=${this.onAppStore.bind(this)}
      chevron
    >
      <wui-text variant="paragraph-500" color="fg-100">iOS App</wui-text>
    </wui-list-item>`:null}androidTemplate(){return this.wallet?.play_store?t.html`<wui-list-item
      variant="icon"
      icon="playStore"
      iconVariant="square"
      @click=${this.onPlayStore.bind(this)}
      chevron
    >
      <wui-text variant="paragraph-500" color="fg-100">Android App</wui-text>
    </wui-list-item>`:null}homepageTemplate(){return this.wallet?.homepage?t.html`
      <wui-list-item
        variant="icon"
        icon="browser"
        iconVariant="square-blue"
        @click=${this.onHomePage.bind(this)}
        chevron
      >
        <wui-text variant="paragraph-500" color="fg-100">Website</wui-text>
      </wui-list-item>
    `:null}onChromeStore(){this.wallet?.chrome_store&&i.CoreHelperUtil.openHref(this.wallet.chrome_store,'_blank')}onAppStore(){this.wallet?.app_store&&i.CoreHelperUtil.openHref(this.wallet.app_store,'_blank')}onPlayStore(){this.wallet?.play_store&&i.CoreHelperUtil.openHref(this.wallet.play_store,'_blank')}onHomePage(){this.wallet?.homepage&&i.CoreHelperUtil.openHref(this.wallet.homepage,'_blank')}};e.W3mDownloadsView=l=r([(0,o.customElement)('w3m-downloads-view')],l)},7028,[4951,4631,4948,4971,7029,4998]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0});var n=r(d[0]);Object.keys(n).forEach(function(t){"default"!==t&&"__esModule"!==t&&(t in e&&e[t]===n[t]||Object.defineProperty(e,t,{enumerable:!0,get:function(){return n[t]}}))})},7029,[7030]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.WuiListItem=void 0;var i=_r(_d[1]),o=_r(_d[2]),n=_r(_d[3]);_r(_d[4]),_r(_d[5]),_r(_d[6]),_r(_d[7]),_r(_d[8]);var r=_r(_d[9]),s=_r(_d[10]);_r(_d[11]);var l=t(_r(_d[12])),c=this&&this.__decorate||function(t,i,o,n){var r,s=arguments.length,l=s<3?i:null===n?n=Object.getOwnPropertyDescriptor(i,o):n;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)l=Reflect.decorate(t,i,o,n);else for(var c=t.length-1;c>=0;c--)(r=t[c])&&(l=(s<3?r(l):s>3?r(i,o,l):r(i,o))||l);return s>3&&l&&Object.defineProperty(i,o,l),l};let p=e.WuiListItem=class extends i.LitElement{constructor(){super(...arguments),this.tabIdx=void 0,this.variant='icon',this.disabled=!1,this.imageSrc=void 0,this.alt=void 0,this.chevron=!1,this.loading=!1}render(){return i.html`
      <button
        ?disabled=${!!this.loading||Boolean(this.disabled)}
        data-loading=${this.loading}
        data-iconvariant=${(0,n.ifDefined)(this.iconVariant)}
        tabindex=${(0,n.ifDefined)(this.tabIdx)}
      >
        ${this.loadingTemplate()} ${this.visualTemplate()}
        <wui-flex gap="3xs">
          <slot></slot>
        </wui-flex>
        ${this.chevronTemplate()}
      </button>
    `}visualTemplate(){if('image'===this.variant&&this.imageSrc)return i.html`<wui-image src=${this.imageSrc} alt=${this.alt??'list item'}></wui-image>`;if('square'===this.iconVariant&&this.icon&&'icon'===this.variant)return i.html`<wui-icon name=${this.icon}></wui-icon>`;if('icon'===this.variant&&this.icon&&this.iconVariant){const t=['blue','square-blue'].includes(this.iconVariant)?'accent-100':'fg-200',o='square-blue'===this.iconVariant?'mdl':'md',n=this.iconSize?this.iconSize:o;return i.html`
        <wui-icon-box
          data-variant=${this.iconVariant}
          icon=${this.icon}
          iconSize=${n}
          background="transparent"
          iconColor=${t}
          backgroundColor=${t}
          size=${o}
        ></wui-icon-box>
      `}return null}loadingTemplate(){return this.loading?i.html`<wui-loading-spinner
        data-testid="wui-list-item-loading-spinner"
        color="fg-300"
      ></wui-loading-spinner>`:i.html``}chevronTemplate(){return this.chevron?i.html`<wui-icon size="inherit" color="fg-200" name="chevronRight"></wui-icon>`:null}};p.styles=[r.resetStyles,r.elementStyles,l.default],c([(0,o.property)()],p.prototype,"icon",void 0),c([(0,o.property)()],p.prototype,"iconSize",void 0),c([(0,o.property)()],p.prototype,"tabIdx",void 0),c([(0,o.property)()],p.prototype,"variant",void 0),c([(0,o.property)()],p.prototype,"iconVariant",void 0),c([(0,o.property)({type:Boolean})],p.prototype,"disabled",void 0),c([(0,o.property)()],p.prototype,"imageSrc",void 0),c([(0,o.property)()],p.prototype,"alt",void 0),c([(0,o.property)({type:Boolean})],p.prototype,"chevron",void 0),c([(0,o.property)({type:Boolean})],p.prototype,"loading",void 0),e.WuiListItem=p=c([(0,s.customElement)('wui-list-item')],p)},7030,[2,4951,4960,4974,4976,4991,4995,4985,4972,4950,4959,4989,7031]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var o=r(d[0]);e.default=o.css`
  button {
    column-gap: var(--wui-spacing-s);
    padding: 11px 18px 11px var(--wui-spacing-s);
    width: 100%;
    background-color: var(--wui-color-gray-glass-002);
    border-radius: var(--wui-border-radius-xs);
    color: var(--wui-color-fg-250);
    transition:
      color var(--wui-ease-out-power-1) var(--wui-duration-md),
      background-color var(--wui-ease-out-power-1) var(--wui-duration-md);
    will-change: color, background-color;
  }

  button[data-iconvariant='square'],
  button[data-iconvariant='square-blue'] {
    padding: 6px 18px 6px 9px;
  }

  button > wui-flex {
    flex: 1;
  }

  button > wui-image {
    width: 32px;
    height: 32px;
    box-shadow: 0 0 0 2px var(--wui-color-gray-glass-005);
    border-radius: var(--wui-border-radius-3xl);
  }

  button > wui-icon {
    width: 36px;
    height: 36px;
    transition: opacity var(--wui-ease-out-power-1) var(--wui-duration-md);
    will-change: opacity;
  }

  button > wui-icon-box[data-variant='blue'] {
    box-shadow: 0 0 0 2px var(--wui-color-accent-glass-005);
  }

  button > wui-icon-box[data-variant='overlay'] {
    box-shadow: 0 0 0 2px var(--wui-color-gray-glass-005);
  }

  button > wui-icon-box[data-variant='square-blue'] {
    border-radius: var(--wui-border-radius-3xs);
    position: relative;
    border: none;
    width: 36px;
    height: 36px;
  }

  button > wui-icon-box[data-variant='square-blue']::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    right: 0;
    border-radius: inherit;
    border: 1px solid var(--wui-color-accent-glass-010);
    pointer-events: none;
  }

  button > wui-icon:last-child {
    width: 14px;
    height: 14px;
  }

  button:disabled {
    color: var(--wui-color-gray-glass-020);
  }

  button[data-loading='true'] > wui-icon {
    opacity: 0;
  }

  wui-loading-spinner {
    position: absolute;
    right: 18px;
    top: 50%;
    transform: translateY(-50%);
  }
`},7031,[4951]);