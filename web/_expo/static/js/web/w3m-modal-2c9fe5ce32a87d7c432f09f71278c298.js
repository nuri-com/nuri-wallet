__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0});var n=r(d[0]);Object.keys(n).forEach(function(t){"default"!==t&&"__esModule"!==t&&(t in e&&e[t]===n[t]||Object.defineProperty(e,t,{enumerable:!0,get:function(){return n[t]}}))});var t=r(d[1]);Object.keys(t).forEach(function(n){"default"!==n&&"__esModule"!==n&&(n in e&&e[n]===t[n]||Object.defineProperty(e,n,{enumerable:!0,get:function(){return t[n]}}))});var u=r(d[2]);Object.keys(u).forEach(function(n){"default"!==n&&"__esModule"!==n&&(n in e&&e[n]===u[n]||Object.defineProperty(e,n,{enumerable:!0,get:function(){return u[n]}}))});var o=r(d[3]);Object.keys(o).forEach(function(n){"default"!==n&&"__esModule"!==n&&(n in e&&e[n]===o[n]||Object.defineProperty(e,n,{enumerable:!0,get:function(){return o[n]}}))})},6090,[6182,6268,6270,6272]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.W3mModalBase=e.W3mModal=e.AppKitModal=void 0;var o=_r(_d[1]),r=_r(_d[2]),s=_r(_d[3]);_r(_d[4]);var i=_r(_d[5]),l=_r(_d[6]);_r(_d[7]),_r(_d[8]),_r(_d[9]),_r(_d[10]),_r(_d[11]),_r(_d[12]),_r(_d[13]);var n=_r(_d[14]);_r(_d[15]),_r(_d[16]);var d=t(_r(_d[17])),c=this&&this.__decorate||function(t,o,r,s){var i,l=arguments.length,n=l<3?o:null===s?s=Object.getOwnPropertyDescriptor(o,r):s;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)n=Reflect.decorate(t,o,r,s);else for(var d=t.length-1;d>=0;d--)(i=t[d])&&(n=(l<3?i(n):l>3?i(o,r,n):i(o,r))||n);return l>3&&n&&Object.defineProperty(o,r,n),n};const h='scroll-lock',p={PayWithExchange:'0',PayWithExchangeSelectAsset:'0',Pay:'0',PayQuote:'0',PayLoading:'0'};class b extends o.LitElement{constructor(){super(),this.unsubscribe=[],this.abortController=void 0,this.hasPrefetched=!1,this.enableEmbedded=i.OptionsController.state.enableEmbedded,this.open=i.ModalController.state.open,this.caipAddress=i.ChainController.state.activeCaipAddress,this.caipNetwork=i.ChainController.state.activeCaipNetwork,this.shake=i.ModalController.state.shake,this.filterByNamespace=i.ConnectorController.state.filterByNamespace,this.padding=l.vars.spacing[1],this.mobileFullScreen=i.OptionsController.state.enableMobileFullScreen,this.initializeTheming(),i.ApiController.prefetchAnalyticsConfig(),this.unsubscribe.push(i.ModalController.subscribeKey('open',t=>t?this.onOpen():this.onClose()),i.ModalController.subscribeKey('shake',t=>this.shake=t),i.ChainController.subscribeKey('activeCaipNetwork',t=>this.onNewNetwork(t)),i.ChainController.subscribeKey('activeCaipAddress',t=>this.onNewAddress(t)),i.OptionsController.subscribeKey('enableEmbedded',t=>this.enableEmbedded=t),i.ConnectorController.subscribeKey('filterByNamespace',t=>{this.filterByNamespace===t||i.ChainController.getAccountData(t)?.caipAddress||(i.ApiController.fetchRecommendedWallets(),this.filterByNamespace=t)}),i.RouterController.subscribeKey('view',()=>{this.dataset.border=n.HelpersUtil.hasFooter()?'true':'false',this.padding=p[i.RouterController.state.view]??l.vars.spacing[1]}))}firstUpdated(){if(this.dataset.border=n.HelpersUtil.hasFooter()?'true':'false',this.mobileFullScreen&&this.setAttribute('data-mobile-fullscreen','true'),this.caipAddress){if(this.enableEmbedded)return i.ModalController.close(),void this.prefetch();this.onNewAddress(this.caipAddress)}this.open&&this.onOpen(),this.enableEmbedded&&this.prefetch()}disconnectedCallback(){this.unsubscribe.forEach(t=>t()),this.onRemoveKeyboardListener()}render(){return this.style.setProperty('--local-modal-padding',this.padding),this.enableEmbedded?o.html`${this.contentTemplate()}
        <w3m-tooltip></w3m-tooltip> `:this.open?o.html`
          <wui-flex @click=${this.onOverlayClick.bind(this)} data-testid="w3m-modal-overlay">
            ${this.contentTemplate()}
          </wui-flex>
          <w3m-tooltip></w3m-tooltip>
        `:null}contentTemplate(){return o.html` <wui-card
      shake="${this.shake}"
      data-embedded="${(0,s.ifDefined)(this.enableEmbedded)}"
      role="alertdialog"
      aria-modal="true"
      tabindex="0"
      data-testid="w3m-modal-card"
    >
      <w3m-header></w3m-header>
      <w3m-router></w3m-router>
      <w3m-footer></w3m-footer>
      <w3m-snackbar></w3m-snackbar>
      <w3m-alertbar></w3m-alertbar>
    </wui-card>`}async onOverlayClick(t){if(t.target===t.currentTarget){if(this.mobileFullScreen)return;await this.handleClose()}}async handleClose(){await i.ModalUtil.safeClose()}initializeTheming(){const{themeVariables:t,themeMode:o}=i.ThemeController.state,r=l.UiHelperUtil.getColorTheme(o);(0,l.initializeTheming)(t,r)}onClose(){this.open=!1,this.classList.remove('open'),this.onScrollUnlock(),i.SnackController.hide(),this.onRemoveKeyboardListener()}onOpen(){this.open=!0,this.classList.add('open'),this.onScrollLock(),this.onAddKeyboardListener()}onScrollLock(){const t=document.createElement('style');t.dataset.w3m=h,t.textContent="\n      body {\n        touch-action: none;\n        overflow: hidden;\n        overscroll-behavior: contain;\n      }\n      w3m-modal {\n        pointer-events: auto;\n      }\n    ",document.head.appendChild(t)}onScrollUnlock(){const t=document.head.querySelector(`style[data-w3m="${h}"]`);t&&t.remove()}onAddKeyboardListener(){this.abortController=new AbortController;const t=this.shadowRoot?.querySelector('wui-card');t?.focus(),window.addEventListener('keydown',o=>{if('Escape'===o.key)this.handleClose();else if('Tab'===o.key){const{tagName:r}=o.target;!r||r.includes('W3M-')||r.includes('WUI-')||t?.focus()}},this.abortController)}onRemoveKeyboardListener(){this.abortController?.abort(),this.abortController=void 0}async onNewAddress(t){const o=i.ChainController.state.isSwitchingNamespace,r='ProfileWallets'===i.RouterController.state.view;!t&&!o&&!r&&i.ModalController.close(),await i.SIWXUtil.initializeIfEnabled(t),this.caipAddress=t,i.ChainController.setIsSwitchingNamespace(!1)}onNewNetwork(t){const o=this.caipNetwork,r=o?.caipNetworkId?.toString(),s=t?.caipNetworkId?.toString(),l=r!==s,n='UnsupportedChain'===i.RouterController.state.view,d=i.ModalController.state.open;let c=!1;this.enableEmbedded&&'SwitchNetwork'===i.RouterController.state.view&&(c=!0),l&&i.SwapController.resetState(),d&&n&&(c=!0),c&&'SIWXSignMessage'!==i.RouterController.state.view&&i.RouterController.goBack(),this.caipNetwork=t}prefetch(){this.hasPrefetched||(i.ApiController.prefetch(),i.ApiController.fetchWalletsByPage({page:1}),this.hasPrefetched=!0)}}e.W3mModalBase=b,b.styles=d.default,c([(0,r.property)({type:Boolean})],b.prototype,"enableEmbedded",void 0),c([(0,r.state)()],b.prototype,"open",void 0),c([(0,r.state)()],b.prototype,"caipAddress",void 0),c([(0,r.state)()],b.prototype,"caipNetwork",void 0),c([(0,r.state)()],b.prototype,"shake",void 0),c([(0,r.state)()],b.prototype,"filterByNamespace",void 0),c([(0,r.state)()],b.prototype,"padding",void 0),c([(0,r.state)()],b.prototype,"mobileFullScreen",void 0);let u=e.W3mModal=class extends b{};e.W3mModal=u=c([(0,l.customElement)('w3m-modal')],u);let C=e.AppKitModal=class extends b{};e.AppKitModal=C=c([(0,l.customElement)('appkit-modal')],C)},6182,[2,4653,4674,4688,4556,4632,4650,6183,4685,6186,6191,6249,6254,6256,6258,6259,6265,6267]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0});var n=r(d[0]);Object.keys(n).forEach(function(t){"default"!==t&&"__esModule"!==t&&(t in e&&e[t]===n[t]||Object.defineProperty(e,t,{enumerable:!0,get:function(){return n[t]}}))})},6183,[6184]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.WuiCard=void 0;var r=_r(_d[1]),l=_r(_d[2]),o=_r(_d[3]),n=t(_r(_d[4])),c=this&&this.__decorate||function(t,r,l,o){var n,c=arguments.length,d=c<3?r:null===o?o=Object.getOwnPropertyDescriptor(r,l):o;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)d=Reflect.decorate(t,r,l,o);else for(var i=t.length-1;i>=0;i--)(n=t[i])&&(d=(c<3?n(d):c>3?n(r,l,d):n(r,l))||d);return c>3&&d&&Object.defineProperty(r,l,d),d};let d=e.WuiCard=class extends r.LitElement{render(){return r.html`<slot></slot>`}};d.styles=[l.resetStyles,n.default],e.WuiCard=d=c([(0,o.customElement)('wui-card')],d)},6184,[2,4653,4652,4663,6185]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var o=r(d[0]);e.default=o.css`
  :host {
    display: block;
    border-radius: clamp(0px, ${({borderRadius:o})=>o[8]}, 44px);
    box-shadow: 0 0 0 1px ${({tokens:o})=>o.theme.foregroundPrimary};
    overflow: hidden;
  }
`},6185,[4659]);
__d(function(g,_r,_i,a,m,e,_d){var r=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.presets=e.W3mAlertBar=void 0;var o=_r(_d[1]),t=_r(_d[2]),n=_r(_d[3]),s=_r(_d[4]);_r(_d[5]);var i=r(_r(_d[6])),c=this&&this.__decorate||function(r,o,t,n){var s,i=arguments.length,c=i<3?o:null===n?n=Object.getOwnPropertyDescriptor(o,t):n;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)c=Reflect.decorate(r,o,t,n);else for(var l=r.length-1;l>=0;l--)(s=r[l])&&(c=(i<3?s(c):i>3?s(o,t,c):s(o,t))||c);return i>3&&c&&Object.defineProperty(o,t,c),c};const l=e.presets={info:{backgroundColor:'fg-350',iconColor:'fg-325',icon:'info'},success:{backgroundColor:'success-glass-reown-020',iconColor:'success-125',icon:'checkmark'},warning:{backgroundColor:'warning-glass-reown-020',iconColor:'warning-100',icon:'warningCircle'},error:{backgroundColor:'error-glass-reown-020',iconColor:'error-125',icon:'warning'}};let u=e.W3mAlertBar=class extends o.LitElement{constructor(){super(),this.unsubscribe=[],this.open=n.AlertController.state.open,this.onOpen(!0),this.unsubscribe.push(n.AlertController.subscribeKey('open',r=>{this.open=r,this.onOpen(!1)}))}disconnectedCallback(){this.unsubscribe.forEach(r=>r())}render(){const{message:r,variant:t}=n.AlertController.state,s=l[t];return o.html`
      <wui-alertbar
        message=${r}
        backgroundColor=${s?.backgroundColor}
        iconColor=${s?.iconColor}
        icon=${s?.icon}
        type=${t}
      ></wui-alertbar>
    `}onOpen(r){this.open?(this.animate([{opacity:0,transform:'scale(0.85)'},{opacity:1,transform:'scale(1)'}],{duration:150,fill:'forwards',easing:'ease'}),this.style.cssText="pointer-events: auto"):r||(this.animate([{opacity:1,transform:'scale(1)'},{opacity:0,transform:'scale(0.85)'}],{duration:150,fill:'forwards',easing:'ease'}),this.style.cssText="pointer-events: none")}};u.styles=i.default,c([(0,t.state)()],u.prototype,"open",void 0),e.W3mAlertBar=u=c([(0,s.customElement)('w3m-alertbar')],u)},6186,[2,4653,4674,4632,4650,6187,6190]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0});var n=r(d[0]);Object.keys(n).forEach(function(t){"default"!==t&&"__esModule"!==t&&(t in e&&e[t]===n[t]||Object.defineProperty(e,t,{enumerable:!0,get:function(){return n[t]}}))})},6187,[6188]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.WuiAlertBar=void 0;var i=_r(_d[1]),r=_r(_d[2]),o=_r(_d[3]),n=_r(_d[4]);_r(_d[5]),_r(_d[6]),_r(_d[7]);var l=_r(_d[8]),s=_r(_d[9]),c=t(_r(_d[10])),u=this&&this.__decorate||function(t,i,r,o){var n,l=arguments.length,s=l<3?i:null===o?o=Object.getOwnPropertyDescriptor(i,r):o;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)s=Reflect.decorate(t,i,r,o);else for(var c=t.length-1;c>=0;c--)(n=t[c])&&(s=(l<3?n(s):l>3?n(i,r,s):n(i,r))||s);return l>3&&s&&Object.defineProperty(i,r,s),s};const f={info:'info',success:'checkmark',warning:'warningCircle',error:'warning'};let p=e.WuiAlertBar=class extends i.LitElement{constructor(){super(...arguments),this.message='',this.type='info'}render(){return i.html`
      <wui-flex
        data-type=${(0,o.ifDefined)(this.type)}
        flexDirection="row"
        justifyContent="space-between"
        alignItems="center"
        gap="2"
      >
        <wui-flex columnGap="2" flexDirection="row" alignItems="center">
          <wui-flex
            flexDirection="row"
            alignItems="center"
            justifyContent="center"
            class="icon-box"
          >
            <wui-icon color="inherit" size="md" name=${f[this.type]}></wui-icon>
          </wui-flex>
          <wui-text variant="md-medium" color="inherit" data-testid="wui-alertbar-text"
            >${this.message}</wui-text
          >
        </wui-flex>
        <wui-icon
          class="close"
          color="inherit"
          size="sm"
          name="close"
          @click=${this.onClose}
        ></wui-icon>
      </wui-flex>
    `}onClose(){n.AlertController.close()}};p.styles=[l.resetStyles,c.default],u([(0,r.property)()],p.prototype,"message",void 0),u([(0,r.property)()],p.prototype,"type",void 0),e.WuiAlertBar=p=u([(0,s.customElement)('wui-alertbar')],p)},6188,[2,4653,4674,4688,4632,4692,4722,4686,4652,4663,6189]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var o=r(d[0]);e.default=o.css`
  :host {
    width: 100%;
  }

  :host > wui-flex {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: ${({spacing:o})=>o[2]};
    padding: ${({spacing:o})=>o[3]};
    border-radius: ${({borderRadius:o})=>o[6]};
    border: 1px solid ${({tokens:o})=>o.theme.borderPrimary};
    box-sizing: border-box;
    background-color: ${({tokens:o})=>o.theme.foregroundPrimary};
    box-shadow: 0px 0px 16px 0px rgba(0, 0, 0, 0.25);
    color: ${({tokens:o})=>o.theme.textPrimary};
  }

  :host > wui-flex[data-type='info'] {
    .icon-box {
      background-color: ${({tokens:o})=>o.theme.foregroundSecondary};

      wui-icon {
        color: ${({tokens:o})=>o.theme.iconDefault};
      }
    }
  }
  :host > wui-flex[data-type='success'] {
    .icon-box {
      background-color: ${({tokens:o})=>o.core.backgroundSuccess};

      wui-icon {
        color: ${({tokens:o})=>o.core.borderSuccess};
      }
    }
  }
  :host > wui-flex[data-type='warning'] {
    .icon-box {
      background-color: ${({tokens:o})=>o.core.backgroundWarning};

      wui-icon {
        color: ${({tokens:o})=>o.core.borderWarning};
      }
    }
  }
  :host > wui-flex[data-type='error'] {
    .icon-box {
      background-color: ${({tokens:o})=>o.core.backgroundError};

      wui-icon {
        color: ${({tokens:o})=>o.core.borderError};
      }
    }
  }

  wui-flex {
    width: 100%;
  }

  wui-text {
    word-break: break-word;
    flex: 1;
  }

  .close {
    cursor: pointer;
    color: ${({tokens:o})=>o.theme.iconDefault};
  }

  .icon-box {
    height: 40px;
    width: 40px;
    border-radius: ${({borderRadius:o})=>o[2]};
    background-color: var(--local-icon-bg-value);
  }
`},6189,[4659]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var t=r(d[0]);e.default=t.css`
  :host {
    display: block;
    position: absolute;
    top: ${({spacing:t})=>t[3]};
    left: ${({spacing:t})=>t[4]};
    right: ${({spacing:t})=>t[4]};
    opacity: 0;
    pointer-events: none;
  }
`},6190,[4650]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.W3mHeader=void 0;var i=_r(_d[1]),o=_r(_d[2]),n=_r(_d[3]),r=_r(_d[4]),l=_r(_d[5]);_r(_d[6]),_r(_d[7]),_r(_d[8]),_r(_d[9]),_r(_d[10]);var s=_r(_d[11]);_r(_d[12]);var c=t(_r(_d[13])),h=this&&this.__decorate||function(t,i,o,n){var r,l=arguments.length,s=l<3?i:null===n?n=Object.getOwnPropertyDescriptor(i,o):n;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)s=Reflect.decorate(t,i,o,n);else for(var c=t.length-1;c>=0;c--)(r=t[c])&&(s=(l<3?r(s):l>3?r(i,o,s):r(i,o))||s);return l>3&&s&&Object.defineProperty(i,o,s),s};const d=['SmartSessionList'],w={PayWithExchange:l.vars.tokens.theme.foregroundPrimary};function u(){const t=r.RouterController.state.data?.connector?.name,i=r.RouterController.state.data?.wallet?.name,o=r.RouterController.state.data?.network?.name,n=i??t,l=r.ConnectorController.getConnectors(),s=1===l.length&&'w3m-email'===l[0]?.id,c=r.ChainController.getAccountData()?.socialProvider;return{Connect:`Connect ${s?'Email':''} Wallet`,Create:'Create Wallet',ChooseAccountName:void 0,Account:void 0,AccountSettings:void 0,AllWallets:'All Wallets',ApproveTransaction:'Approve Transaction',BuyInProgress:'Buy',UsageExceeded:'Usage Exceeded',ConnectingExternal:n??'Connect Wallet',ConnectingWalletConnect:n??'WalletConnect',ConnectingWalletConnectBasic:'WalletConnect',ConnectingSiwe:'Sign In',Convert:'Convert',ConvertSelectToken:'Select token',ConvertPreview:'Preview Convert',Downloads:n?`Get ${n}`:'Downloads',EmailLogin:'Email Login',EmailVerifyOtp:'Confirm Email',EmailVerifyDevice:'Register Device',GetWallet:'Get a Wallet',Networks:'Choose Network',OnRampProviders:'Choose Provider',OnRampActivity:'Activity',OnRampTokenSelect:'Select Token',OnRampFiatSelect:'Select Currency',Pay:'How you pay',ProfileWallets:'Wallets',SwitchNetwork:o??'Switch Network',Transactions:'Activity',UnsupportedChain:'Switch Network',UpgradeEmailWallet:'Upgrade Your Wallet',UpdateEmailWallet:'Edit Email',UpdateEmailPrimaryOtp:'Confirm Current Email',UpdateEmailSecondaryOtp:'Confirm New Email',WhatIsABuy:'What is Buy?',RegisterAccountName:'Choose Name',RegisterAccountNameSuccess:'',WalletReceive:'Receive',WalletCompatibleNetworks:'Compatible Networks',Swap:'Swap',SwapSelectToken:'Select Token',SwapPreview:'Preview Swap',WalletSend:'Send',WalletSendPreview:'Review Send',WalletSendSelectToken:'Select Token',WalletSendConfirmed:'Confirmed',WhatIsANetwork:'What is a network?',WhatIsAWallet:'What is a Wallet?',ConnectWallets:'Connect Wallet',ConnectSocials:'All Socials',ConnectingSocial:c?c.charAt(0).toUpperCase()+c.slice(1):'Connect Social',ConnectingMultiChain:'Select Chain',ConnectingFarcaster:'Farcaster',SwitchActiveChain:'Switch Chain',SmartSessionCreated:void 0,SmartSessionList:'Smart Sessions',SIWXSignMessage:'Sign In',PayLoading:'Processing payment...',PayQuote:'Payment Quote',DataCapture:'Profile',DataCaptureOtpConfirm:'Confirm Email',FundWallet:'Fund Wallet',PayWithExchange:'Deposit from Exchange',PayWithExchangeSelectAsset:'Select Asset',SmartAccountSettings:'Smart Account Settings'}}let p=e.W3mHeader=class extends i.LitElement{constructor(){super(),this.unsubscribe=[],this.heading=u()[r.RouterController.state.view],this.network=r.ChainController.state.activeCaipNetwork,this.networkImage=r.AssetUtil.getNetworkImage(this.network),this.showBack=!1,this.prevHistoryLength=1,this.view=r.RouterController.state.view,this.viewDirection='',this.unsubscribe.push(r.AssetController.subscribeNetworkImages(()=>{this.networkImage=r.AssetUtil.getNetworkImage(this.network)}),r.RouterController.subscribeKey('view',t=>{setTimeout(()=>{this.view=t,this.heading=u()[t]},s.ConstantsUtil.ANIMATION_DURATIONS.HeaderText),this.onViewChange(),this.onHistoryChange()}),r.ChainController.subscribeKey('activeCaipNetwork',t=>{this.network=t,this.networkImage=r.AssetUtil.getNetworkImage(this.network)}))}disconnectCallback(){this.unsubscribe.forEach(t=>t())}render(){const t=w[r.RouterController.state.view]??l.vars.tokens.theme.backgroundPrimary;return this.style.setProperty('--local-header-background-color',t),i.html`
      <wui-flex
        .padding=${['0','4','0','4']}
        justifyContent="space-between"
        alignItems="center"
      >
        ${this.leftHeaderTemplate()} ${this.titleTemplate()} ${this.rightHeaderTemplate()}
      </wui-flex>
    `}onWalletHelp(){r.EventsController.sendEvent({type:'track',event:'CLICK_WALLET_HELP'}),r.RouterController.push('WhatIsAWallet')}async onClose(){await r.ModalUtil.safeClose()}rightHeaderTemplate(){const t=r.OptionsController?.state?.features?.smartSessions;return'Account'===r.RouterController.state.view&&t?i.html`<wui-flex>
      <wui-icon-button
        icon="clock"
        size="lg"
        iconSize="lg"
        type="neutral"
        variant="primary"
        @click=${()=>r.RouterController.push('SmartSessionList')}
        data-testid="w3m-header-smart-sessions"
      ></wui-icon-button>
      ${this.closeButtonTemplate()}
    </wui-flex> `:this.closeButtonTemplate()}closeButtonTemplate(){return i.html`
      <wui-icon-button
        icon="close"
        size="lg"
        type="neutral"
        variant="primary"
        iconSize="lg"
        @click=${this.onClose.bind(this)}
        data-testid="w3m-header-close"
      ></wui-icon-button>
    `}titleTemplate(){if('PayQuote'===this.view)return i.html`<w3m-pay-header></w3m-pay-header>`;const t=d.includes(this.view);return i.html`
      <wui-flex
        view-direction="${this.viewDirection}"
        class="w3m-header-title"
        alignItems="center"
        gap="2"
      >
        <wui-text
          display="inline"
          variant="lg-regular"
          color="primary"
          data-testid="w3m-header-text"
        >
          ${this.heading}
        </wui-text>
        ${t?i.html`<wui-tag variant="accent" size="md">Beta</wui-tag>`:null}
      </wui-flex>
    `}leftHeaderTemplate(){const{view:t}=r.RouterController.state,o='Connect'===t,l=r.OptionsController.state.enableEmbedded,s='ApproveTransaction'===t,c='ConnectingSiwe'===t,h='Account'===t,d=r.OptionsController.state.enableNetworkSwitch,w=s||c||o&&l;return h&&d?i.html`<wui-select
        id="dynamic"
        data-testid="w3m-account-select-network"
        active-network=${(0,n.ifDefined)(this.network?.name)}
        @click=${this.onNetworks.bind(this)}
        imageSrc=${(0,n.ifDefined)(this.networkImage)}
      ></wui-select>`:this.showBack&&!w?i.html`<wui-icon-button
        data-testid="header-back"
        id="dynamic"
        icon="chevronLeft"
        size="lg"
        iconSize="lg"
        type="neutral"
        variant="primary"
        @click=${this.onGoBack.bind(this)}
      ></wui-icon-button>`:i.html`<wui-icon-button
      data-hidden=${!o}
      id="dynamic"
      icon="helpCircle"
      size="lg"
      iconSize="lg"
      type="neutral"
      variant="primary"
      @click=${this.onWalletHelp.bind(this)}
    ></wui-icon-button>`}onNetworks(){this.isAllowedNetworkSwitch()&&(r.EventsController.sendEvent({type:'track',event:'CLICK_NETWORKS'}),r.RouterController.push('Networks'))}isAllowedNetworkSwitch(){const t=r.ChainController.getAllRequestedCaipNetworks(),i=!!t&&t.length>1,o=t?.find(({id:t})=>t===this.network?.id);return i||!o}onViewChange(){const{history:t}=r.RouterController.state;let i=s.ConstantsUtil.VIEW_DIRECTION.Next;t.length<this.prevHistoryLength&&(i=s.ConstantsUtil.VIEW_DIRECTION.Prev),this.prevHistoryLength=t.length,this.viewDirection=i}async onHistoryChange(){const{history:t}=r.RouterController.state,i=this.shadowRoot?.querySelector('#dynamic');t.length>1&&!this.showBack&&i?(await i.animate([{opacity:1},{opacity:0}],{duration:200,fill:'forwards',easing:'ease'}).finished,this.showBack=!0,i.animate([{opacity:0},{opacity:1}],{duration:200,fill:'forwards',easing:'ease'})):t.length<=1&&this.showBack&&i&&(await i.animate([{opacity:1},{opacity:0}],{duration:200,fill:'forwards',easing:'ease'}).finished,this.showBack=!1,i.animate([{opacity:0},{opacity:1}],{duration:200,fill:'forwards',easing:'ease'}))}onGoBack(){r.RouterController.goBack()}};p.styles=c.default,h([(0,o.state)()],p.prototype,"heading",void 0),h([(0,o.state)()],p.prototype,"network",void 0),h([(0,o.state)()],p.prototype,"networkImage",void 0),h([(0,o.state)()],p.prototype,"showBack",void 0),h([(0,o.state)()],p.prototype,"prevHistoryLength",void 0),h([(0,o.state)()],p.prototype,"view",void 0),h([(0,o.state)()],p.prototype,"viewDirection",void 0),e.W3mHeader=p=h([(0,l.customElement)('w3m-header')],p)},6191,[2,4653,4674,4688,4632,4650,4685,6192,6195,6198,4747,6199,6200,6248]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0});var n=r(d[0]);Object.keys(n).forEach(function(t){"default"!==t&&"__esModule"!==t&&(t in e&&e[t]===n[t]||Object.defineProperty(e,t,{enumerable:!0,get:function(){return n[t]}}))})},6192,[6193]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.WuiIconButton=void 0;var i=_r(_d[1]),o=_r(_d[2]),r=_r(_d[3]);_r(_d[4]);var n=_r(_d[5]),p=_r(_d[6]),s=t(_r(_d[7])),d=this&&this.__decorate||function(t,i,o,r){var n,p=arguments.length,s=p<3?i:null===r?r=Object.getOwnPropertyDescriptor(i,o):r;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)s=Reflect.decorate(t,i,o,r);else for(var d=t.length-1;d>=0;d--)(n=t[d])&&(s=(p<3?n(s):p>3?n(i,o,s):n(i,o))||s);return p>3&&s&&Object.defineProperty(i,o,s),s};let l=e.WuiIconButton=class extends i.LitElement{constructor(){super(...arguments),this.icon='card',this.variant='primary',this.type='accent',this.size='md',this.iconSize=void 0,this.fullWidth=!1,this.disabled=!1}render(){return i.html`<button
      data-variant=${this.variant}
      data-type=${this.type}
      data-size=${this.size}
      data-full-width=${this.fullWidth}
      ?disabled=${this.disabled}
    >
      <wui-icon color="inherit" name=${this.icon} size=${(0,r.ifDefined)(this.iconSize)}></wui-icon>
    </button>`}};l.styles=[n.resetStyles,n.elementStyles,s.default],d([(0,o.property)()],l.prototype,"icon",void 0),d([(0,o.property)()],l.prototype,"variant",void 0),d([(0,o.property)()],l.prototype,"type",void 0),d([(0,o.property)()],l.prototype,"size",void 0),d([(0,o.property)()],l.prototype,"iconSize",void 0),d([(0,o.property)({type:Boolean})],l.prototype,"fullWidth",void 0),d([(0,o.property)({type:Boolean})],l.prototype,"disabled",void 0),e.WuiIconButton=l=d([(0,p.customElement)('wui-icon-button')],l)},6193,[2,4653,4674,4688,4692,4652,4663,6194]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var t=r(d[0]);e.default=t.css`
  :host {
    position: relative;
  }

  button {
    display: flex;
    justify-content: center;
    align-items: center;
    background-color: transparent;
    padding: ${({spacing:t})=>t[1]};
  }

  /* -- Colors --------------------------------------------------- */
  button[data-type='accent'] wui-icon {
    color: ${({tokens:t})=>t.core.iconAccentPrimary};
  }

  button[data-type='neutral'][data-variant='primary'] wui-icon {
    color: ${({tokens:t})=>t.theme.iconInverse};
  }

  button[data-type='neutral'][data-variant='secondary'] wui-icon {
    color: ${({tokens:t})=>t.theme.iconDefault};
  }

  button[data-type='success'] wui-icon {
    color: ${({tokens:t})=>t.core.iconSuccess};
  }

  button[data-type='error'] wui-icon {
    color: ${({tokens:t})=>t.core.iconError};
  }

  /* -- Sizes --------------------------------------------------- */
  button[data-size='xs'] {
    width: 16px;
    height: 16px;

    border-radius: ${({borderRadius:t})=>t[1]};
  }

  button[data-size='sm'] {
    width: 20px;
    height: 20px;
    border-radius: ${({borderRadius:t})=>t[1]};
  }

  button[data-size='md'] {
    width: 24px;
    height: 24px;
    border-radius: ${({borderRadius:t})=>t[2]};
  }

  button[data-size='lg'] {
    width: 28px;
    height: 28px;
    border-radius: ${({borderRadius:t})=>t[2]};
  }

  button[data-size='xs'] wui-icon {
    width: 8px;
    height: 8px;
  }

  button[data-size='sm'] wui-icon {
    width: 12px;
    height: 12px;
  }

  button[data-size='md'] wui-icon {
    width: 16px;
    height: 16px;
  }

  button[data-size='lg'] wui-icon {
    width: 20px;
    height: 20px;
  }

  /* -- Hover --------------------------------------------------- */
  @media (hover: hover) {
    button[data-type='accent']:hover:enabled {
      background-color: ${({tokens:t})=>t.core.foregroundAccent010};
    }

    button[data-variant='primary'][data-type='neutral']:hover:enabled {
      background-color: ${({tokens:t})=>t.theme.foregroundSecondary};
    }

    button[data-variant='secondary'][data-type='neutral']:hover:enabled {
      background-color: ${({tokens:t})=>t.theme.foregroundSecondary};
    }

    button[data-type='success']:hover:enabled {
      background-color: ${({tokens:t})=>t.core.backgroundSuccess};
    }

    button[data-type='error']:hover:enabled {
      background-color: ${({tokens:t})=>t.core.backgroundError};
    }
  }

  /* -- Focus --------------------------------------------------- */
  button:focus-visible {
    box-shadow: 0 0 0 4px ${({tokens:t})=>t.core.foregroundAccent020};
  }

  /* -- Properties --------------------------------------------------- */
  button[data-full-width='true'] {
    width: 100%;
  }

  :host([fullWidth]) {
    width: 100%;
  }

  button[disabled] {
    opacity: 0.5;
    cursor: not-allowed;
  }
`},6194,[4659]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0});var n=r(d[0]);Object.keys(n).forEach(function(t){"default"!==t&&"__esModule"!==t&&(t in e&&e[t]===n[t]||Object.defineProperty(e,t,{enumerable:!0,get:function(){return n[t]}}))})},6195,[6196]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.WuiSelect=void 0;var i=_r(_d[1]),r=_r(_d[2]);_r(_d[3]),_r(_d[4]),_r(_d[5]);var o=_r(_d[6]),l=_r(_d[7]),s=t(_r(_d[8])),n=this&&this.__decorate||function(t,i,r,o){var l,s=arguments.length,n=s<3?i:null===o?o=Object.getOwnPropertyDescriptor(i,r):o;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)n=Reflect.decorate(t,i,r,o);else for(var c=t.length-1;c>=0;c--)(l=t[c])&&(n=(s<3?l(n):s>3?l(i,r,n):l(i,r))||n);return s>3&&n&&Object.defineProperty(i,r,n),n};const c={lg:'lg-regular',md:'md-regular',sm:'sm-regular'},p={lg:'lg',md:'md',sm:'sm'};let u=e.WuiSelect=class extends i.LitElement{constructor(){super(...arguments),this.imageSrc='',this.text='',this.size='lg',this.type='text-dropdown',this.disabled=!1}render(){return i.html`<button ?disabled=${this.disabled} data-size=${this.size} data-type=${this.type}>
      ${this.imageTemplate()} ${this.textTemplate()}
      <wui-flex class="right-icon-container">
        <wui-icon name="chevronBottom"></wui-icon>
      </wui-flex>
    </button>`}textTemplate(){const t=c[this.size];return this.text?i.html`<wui-text color="primary" variant=${t}>${this.text}</wui-text>`:null}imageTemplate(){if(this.imageSrc)return i.html`<wui-image src=${this.imageSrc} alt="select visual"></wui-image>`;const t=p[this.size];return i.html` <wui-flex class="left-icon-container">
      <wui-icon size=${t} name="networkPlaceholder"></wui-icon>
    </wui-flex>`}};u.styles=[o.resetStyles,o.elementStyles,s.default],n([(0,r.property)()],u.prototype,"imageSrc",void 0),n([(0,r.property)()],u.prototype,"text",void 0),n([(0,r.property)()],u.prototype,"size",void 0),n([(0,r.property)()],u.prototype,"type",void 0),n([(0,r.property)({type:Boolean})],u.prototype,"disabled",void 0),e.WuiSelect=u=n([(0,l.customElement)('wui-select')],u)},6196,[2,4653,4674,4692,4731,4722,4652,4663,6197]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var t=r(d[0]);e.default=t.css`
  button {
    display: block;
    display: flex;
    align-items: center;
    padding: ${({spacing:t})=>t[1]};
    transition: background-color ${({durations:t})=>t.lg}
      ${({easings:t})=>t['ease-out-power-2']};
    will-change: background-color;
    border-radius: ${({borderRadius:t})=>t[32]};
  }

  wui-image {
    border-radius: 100%;
  }

  wui-text {
    padding-left: ${({spacing:t})=>t[1]};
  }

  .left-icon-container,
  .right-icon-container {
    width: 24px;
    height: 24px;
    justify-content: center;
    align-items: center;
  }

  wui-icon {
    color: ${({tokens:t})=>t.theme.iconDefault};
  }

  /* -- Sizes --------------------------------------------------- */
  button[data-size='lg'] {
    height: 32px;
  }

  button[data-size='md'] {
    height: 28px;
  }

  button[data-size='sm'] {
    height: 24px;
  }

  button[data-size='lg'] wui-image {
    width: 24px;
    height: 24px;
  }

  button[data-size='md'] wui-image {
    width: 20px;
    height: 20px;
  }

  button[data-size='sm'] wui-image {
    width: 16px;
    height: 16px;
  }

  button[data-size='lg'] .left-icon-container {
    width: 24px;
    height: 24px;
  }

  button[data-size='md'] .left-icon-container {
    width: 20px;
    height: 20px;
  }

  button[data-size='sm'] .left-icon-container {
    width: 16px;
    height: 16px;
  }

  /* -- Variants --------------------------------------------------------- */
  button[data-type='filled-dropdown'] {
    background-color: ${({tokens:t})=>t.theme.foregroundPrimary};
  }

  button[data-type='text-dropdown'] {
    background-color: transparent;
  }

  /* -- Focus states --------------------------------------------------- */
  button:focus-visible:enabled {
    background-color: ${({tokens:t})=>t.theme.foregroundSecondary};
    box-shadow: 0 0 0 4px ${({tokens:t})=>t.core.foregroundAccent040};
  }

  /* -- Hover & Active states ----------------------------------------------------------- */
  @media (hover: hover) and (pointer: fine) {
    button:hover:enabled,
    button:active:enabled {
      background-color: ${({tokens:t})=>t.theme.foregroundSecondary};
    }
  }

  /* -- Disabled states --------------------------------------------------- */
  button:disabled {
    background-color: ${({tokens:t})=>t.theme.foregroundSecondary};
    opacity: 0.5;
  }
`},6197,[4659]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0});var n=r(d[0]);Object.keys(n).forEach(function(t){"default"!==t&&"__esModule"!==t&&(t in e&&e[t]===n[t]||Object.defineProperty(e,t,{enumerable:!0,get:function(){return n[t]}}))})},6198,[4735]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.ConstantsUtil=void 0;e.ConstantsUtil={ACCOUNT_TABS:[{label:'Tokens'},{label:'Activity'}],SECURE_SITE_ORIGIN:('undefined'!=typeof process&&void 0!==process.env?process.env.NEXT_PUBLIC_SECURE_SITE_ORIGIN:void 0)||'https://secure.walletconnect.org',VIEW_DIRECTION:{Next:'next',Prev:'prev'},ANIMATION_DURATIONS:{HeaderText:120,ModalHeight:150,ViewTransition:150},VIEWS_WITH_LEGAL_FOOTER:['Connect','ConnectWallets','OnRampTokenSelect','OnRampFiatSelect','OnRampProviders'],VIEWS_WITH_DEFAULT_FOOTER:['Networks']}},6199,[]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.W3mPayHeader=void 0;var r=_r(_d[1]),s=_r(_d[2]),n=_r(_d[3]),o=_r(_d[4]),i=_r(_d[5]),l=_r(_d[6]);_r(_d[7]),_r(_d[8]);var u=t(_r(_d[9])),c=this&&this.__decorate||function(t,r,s,n){var o,i=arguments.length,l=i<3?r:null===n?n=Object.getOwnPropertyDescriptor(r,s):n;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)l=Reflect.decorate(t,r,s,n);else for(var u=t.length-1;u>=0;u--)(o=t[u])&&(l=(i<3?o(l):i>3?o(r,s,l):o(r,s))||l);return i>3&&l&&Object.defineProperty(r,s,l),l};let y=e.W3mPayHeader=class extends r.LitElement{constructor(){super(),this.unsubscribe=[],this.paymentAsset=i.PayController.state.paymentAsset,this.amount=i.PayController.state.amount,this.unsubscribe.push(i.PayController.subscribeKey('paymentAsset',t=>{this.paymentAsset=t}),i.PayController.subscribeKey('amount',t=>{this.amount=t}))}disconnectedCallback(){this.unsubscribe.forEach(t=>t())}render(){const t=o.ChainController.getAllRequestedCaipNetworks().find(t=>t.caipNetworkId===this.paymentAsset.network);return r.html`<wui-flex
      alignItems="center"
      gap="1"
      .padding=${['1','2','1','1']}
      class="transfers-badge"
    >
      <wui-image src=${(0,n.ifDefined)(this.paymentAsset.metadata.logoURI)} size="xl"></wui-image>
      <wui-text variant="lg-regular" color="primary">
        ${this.amount} ${this.paymentAsset.metadata.symbol}
      </wui-text>
      <wui-text variant="sm-regular" color="secondary">
        on ${t?.name??'Unknown'}
      </wui-text>
    </wui-flex>`}};y.styles=[u.default],c([(0,s.property)()],y.prototype,"paymentAsset",void 0),c([(0,s.property)()],y.prototype,"amount",void 0),e.W3mPayHeader=y=c([(0,l.customElement)('w3m-pay-header')],y)},6200,[2,4653,4674,4688,4632,6201,4650,4685,4747,6247]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0});var t={openPay:!0,getExchanges:!0,getPayResult:!0,getPayError:!0,getIsPaymentInProgress:!0,pay:!0,PayController:!0};Object.defineProperty(e,"PayController",{enumerable:!0,get:function(){return y.PayController}}),Object.defineProperty(e,"getExchanges",{enumerable:!0,get:function(){return c.getExchanges}}),Object.defineProperty(e,"getIsPaymentInProgress",{enumerable:!0,get:function(){return c.getIsPaymentInProgress}}),Object.defineProperty(e,"getPayError",{enumerable:!0,get:function(){return c.getPayError}}),Object.defineProperty(e,"getPayResult",{enumerable:!0,get:function(){return c.getPayResult}}),Object.defineProperty(e,"openPay",{enumerable:!0,get:function(){return c.openPay}}),Object.defineProperty(e,"pay",{enumerable:!0,get:function(){return c.pay}});var n=r(d[0]);Object.keys(n).forEach(function(o){"default"!==o&&"__esModule"!==o&&(Object.prototype.hasOwnProperty.call(t,o)||o in e&&e[o]===n[o]||Object.defineProperty(e,o,{enumerable:!0,get:function(){return n[o]}}))});var o=r(d[1]);Object.keys(o).forEach(function(n){"default"!==n&&"__esModule"!==n&&(Object.prototype.hasOwnProperty.call(t,n)||n in e&&e[n]===o[n]||Object.defineProperty(e,n,{enumerable:!0,get:function(){return o[n]}}))});var u=r(d[2]);Object.keys(u).forEach(function(n){"default"!==n&&"__esModule"!==n&&(Object.prototype.hasOwnProperty.call(t,n)||n in e&&e[n]===u[n]||Object.defineProperty(e,n,{enumerable:!0,get:function(){return u[n]}}))});var c=r(d[3]),y=r(d[4]),l=r(d[5]);Object.keys(l).forEach(function(n){"default"!==n&&"__esModule"!==n&&(Object.prototype.hasOwnProperty.call(t,n)||n in e&&e[n]===l[n]||Object.defineProperty(e,n,{enumerable:!0,get:function(){return l[n]}}))})},6201,[6202,6224,6230,6245,6215,6246]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.W3mPayView=void 0;var i=_r(_d[1]),n=_r(_d[2]),o=_r(_d[3]);_r(_d[4]);var r=_r(_d[5]),s=_r(_d[6]);_r(_d[7]),_r(_d[8]),_r(_d[9]),_r(_d[10]),_r(_d[11]),_r(_d[12]),_r(_d[13]),_r(_d[14]),_r(_d[15]),_r(_d[16]),_r(_d[17]),_r(_d[18]);var l=_r(_d[19]),c=_r(_d[20]),u=_r(_d[21]),d=t(_r(_d[22])),p=this&&this.__decorate||function(t,i,n,o){var r,s=arguments.length,l=s<3?i:null===o?o=Object.getOwnPropertyDescriptor(i,n):o;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)l=Reflect.decorate(t,i,n,o);else for(var c=t.length-1;c>=0;c--)(r=t[c])&&(l=(s<3?r(l):s>3?r(i,n,l):r(i,n))||l);return s>3&&l&&Object.defineProperty(i,n,l),l};let h=e.W3mPayView=class extends i.LitElement{constructor(){super(),this.unsubscribe=[],this.amount=l.PayController.state.amount,this.namespace=void 0,this.paymentAsset=l.PayController.state.paymentAsset,this.activeConnectorIds=r.ConnectorController.state.activeConnectorIds,this.caipAddress=void 0,this.exchanges=l.PayController.state.exchanges,this.isLoading=l.PayController.state.isLoading,this.initializeNamespace(),this.unsubscribe.push(l.PayController.subscribeKey('amount',t=>this.amount=t)),this.unsubscribe.push(r.ConnectorController.subscribeKey('activeConnectorIds',t=>this.activeConnectorIds=t)),this.unsubscribe.push(l.PayController.subscribeKey('exchanges',t=>this.exchanges=t)),this.unsubscribe.push(l.PayController.subscribeKey('isLoading',t=>this.isLoading=t)),l.PayController.fetchExchanges(),l.PayController.setSelectedExchange(void 0)}disconnectedCallback(){this.unsubscribe.forEach(t=>t())}render(){return i.html`
      <wui-flex flexDirection="column">
        ${this.paymentDetailsTemplate()} ${this.paymentMethodsTemplate()}
      </wui-flex>
    `}paymentMethodsTemplate(){return i.html`
      <wui-flex flexDirection="column" padding="3" gap="2" class="payment-methods-container">
        ${this.payWithWalletTemplate()} ${this.templateSeparator()}
        ${this.templateExchangeOptions()}
      </wui-flex>
    `}initializeNamespace(){const t=r.ChainController.state.activeChain;this.namespace=t,this.caipAddress=r.ChainController.getAccountData(t)?.caipAddress,this.unsubscribe.push(r.ChainController.subscribeChainProp('accountState',t=>{this.caipAddress=t?.caipAddress},t))}paymentDetailsTemplate(){const t=r.ChainController.getAllRequestedCaipNetworks().find(t=>t.caipNetworkId===this.paymentAsset.network);return i.html`
      <wui-flex
        alignItems="center"
        justifyContent="space-between"
        .padding=${['6','8','6','8']}
        gap="2"
      >
        <wui-flex alignItems="center" gap="1">
          <wui-text variant="h1-regular" color="primary">
            ${(0,c.formatAmount)(this.amount||'0')}
          </wui-text>

          <wui-flex flexDirection="column">
            <wui-text variant="h6-regular" color="secondary">
              ${this.paymentAsset.metadata.symbol||'Unknown'}
            </wui-text>
            <wui-text variant="md-medium" color="secondary"
              >on ${t?.name||'Unknown'}</wui-text
            >
          </wui-flex>
        </wui-flex>

        <wui-flex class="left-image-container">
          <wui-image
            src=${(0,o.ifDefined)(this.paymentAsset.metadata.logoURI)}
            class="token-image"
          ></wui-image>
          <wui-image
            src=${(0,o.ifDefined)(r.AssetUtil.getNetworkImage(t))}
            class="chain-image"
          ></wui-image>
        </wui-flex>
      </wui-flex>
    `}payWithWalletTemplate(){return(0,c.isPayWithWalletSupported)(this.paymentAsset.network)?this.caipAddress?this.connectedWalletTemplate():this.disconnectedWalletTemplate():i.html``}connectedWalletTemplate(){const{name:t,image:n}=this.getWalletProperties({namespace:this.namespace});return i.html`
      <wui-flex flexDirection="column" gap="3">
        <wui-list-item
          type="secondary"
          boxColor="foregroundSecondary"
          @click=${this.onWalletPayment}
          .boxed=${!1}
          ?chevron=${!0}
          ?fullSize=${!1}
          ?rounded=${!0}
          data-testid="wallet-payment-option"
          imageSrc=${(0,o.ifDefined)(n)}
          imageSize="3xl"
        >
          <wui-text variant="lg-regular" color="primary">Pay with ${t}</wui-text>
        </wui-list-item>

        <wui-list-item
          type="secondary"
          icon="power"
          iconColor="error"
          @click=${this.onDisconnect}
          data-testid="disconnect-button"
          ?chevron=${!1}
          boxColor="foregroundSecondary"
        >
          <wui-text variant="lg-regular" color="secondary">Disconnect</wui-text>
        </wui-list-item>
      </wui-flex>
    `}disconnectedWalletTemplate(){return i.html`<wui-list-item
      type="secondary"
      boxColor="foregroundSecondary"
      variant="icon"
      iconColor="default"
      iconVariant="overlay"
      icon="wallet"
      @click=${this.onWalletPayment}
      ?chevron=${!0}
      data-testid="wallet-payment-option"
    >
      <wui-text variant="lg-regular" color="primary">Pay with wallet</wui-text>
    </wui-list-item>`}templateExchangeOptions(){if(this.isLoading)return i.html`<wui-flex justifyContent="center" alignItems="center">
        <wui-loading-spinner size="md"></wui-loading-spinner>
      </wui-flex>`;const t=this.exchanges.filter(t=>(0,c.isTestnetAsset)(this.paymentAsset)?t.id===u.REOWN_TEST_EXCHANGE_ID:t.id!==u.REOWN_TEST_EXCHANGE_ID);return 0===t.length?i.html`<wui-flex justifyContent="center" alignItems="center">
        <wui-text variant="md-medium" color="primary">No exchanges available</wui-text>
      </wui-flex>`:t.map(t=>i.html`
        <wui-list-item
          type="secondary"
          boxColor="foregroundSecondary"
          @click=${()=>this.onExchangePayment(t)}
          data-testid="exchange-option-${t.id}"
          ?chevron=${!0}
          imageSrc=${(0,o.ifDefined)(t.imageUrl)}
        >
          <wui-text flexGrow="1" variant="lg-regular" color="primary">
            Pay with ${t.name}
          </wui-text>
        </wui-list-item>
      `)}templateSeparator(){return i.html`<wui-separator text="or" bgColor="secondary"></wui-separator>`}async onWalletPayment(){if(!this.namespace)throw new Error('Namespace not found');this.caipAddress?r.RouterController.push('PayQuote'):(await r.ConnectorController.connect(),await r.ModalController.open({view:'PayQuote'}))}onExchangePayment(t){l.PayController.setSelectedExchange(t),r.RouterController.push('PayQuote')}async onDisconnect(){try{await r.ConnectionController.disconnect(),await r.ModalController.open({view:'Pay'})}catch{console.error('Failed to disconnect'),r.SnackController.showError('Failed to disconnect')}}getWalletProperties({namespace:t}){if(!t)return{name:void 0,image:void 0};const i=this.activeConnectorIds[t];if(!i)return{name:void 0,image:void 0};const n=r.ConnectorController.getConnector({id:i,namespace:t});if(!n)return{name:void 0,image:void 0};const o=r.AssetUtil.getConnectorImage(n);return{name:n.name,image:o}}};h.styles=d.default,p([(0,n.state)()],h.prototype,"amount",void 0),p([(0,n.state)()],h.prototype,"namespace",void 0),p([(0,n.state)()],h.prototype,"paymentAsset",void 0),p([(0,n.state)()],h.prototype,"activeConnectorIds",void 0),p([(0,n.state)()],h.prototype,"caipAddress",void 0),p([(0,n.state)()],h.prototype,"exchanges",void 0),p([(0,n.state)()],h.prototype,"isLoading",void 0),e.W3mPayView=h=p([(0,s.customElement)('w3m-pay-view')],h)},6202,[2,4653,4674,4688,4556,4632,4650,4738,4685,4743,6192,6203,6206,4758,4757,6207,6212,4747,4748,6215,6222,6220,6223]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0});var n=r(d[0]);Object.keys(n).forEach(function(t){"default"!==t&&"__esModule"!==t&&(t in e&&e[t]===n[t]||Object.defineProperty(e,t,{enumerable:!0,get:function(){return n[t]}}))})},6203,[6204]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.WuiIconLink=void 0;var i=_r(_d[1]),o=_r(_d[2]);_r(_d[3]);var r=_r(_d[4]),n=_r(_d[5]),s=t(_r(_d[6])),c=this&&this.__decorate||function(t,i,o,r){var n,s=arguments.length,c=s<3?i:null===r?r=Object.getOwnPropertyDescriptor(i,o):r;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)c=Reflect.decorate(t,i,o,r);else for(var l=t.length-1;l>=0;l--)(n=t[l])&&(c=(s<3?n(c):s>3?n(i,o,c):n(i,o))||c);return s>3&&c&&Object.defineProperty(i,o,c),c};let l=e.WuiIconLink=class extends i.LitElement{constructor(){super(...arguments),this.size='md',this.disabled=!1,this.icon='copy',this.iconColor='default',this.variant='accent'}render(){return i.html`
      <button data-variant=${this.variant} ?disabled=${this.disabled} data-size=${this.size}>
        <wui-icon
          color=${{accent:'accent-primary',primary:'inverse',secondary:'default'}[this.variant]||this.iconColor}
          size=${this.size}
          name=${this.icon}
        ></wui-icon>
      </button>
    `}};l.styles=[r.resetStyles,r.elementStyles,s.default],c([(0,o.property)()],l.prototype,"size",void 0),c([(0,o.property)({type:Boolean})],l.prototype,"disabled",void 0),c([(0,o.property)()],l.prototype,"icon",void 0),c([(0,o.property)()],l.prototype,"iconColor",void 0),c([(0,o.property)()],l.prototype,"variant",void 0),e.WuiIconLink=l=c([(0,n.customElement)('wui-icon-link')],l)},6204,[2,4653,4674,4692,4652,4663,6205]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var t=r(d[0]);e.default=t.css`
  button {
    background-color: transparent;
    padding: ${({spacing:t})=>t[1]};
  }

  button:focus-visible {
    box-shadow: 0 0 0 4px ${({tokens:t})=>t.core.foregroundAccent020};
  }

  button[data-variant='accent']:hover:enabled,
  button[data-variant='accent']:focus-visible {
    background-color: ${({tokens:t})=>t.core.foregroundAccent010};
  }

  button[data-variant='primary']:hover:enabled,
  button[data-variant='primary']:focus-visible,
  button[data-variant='secondary']:hover:enabled,
  button[data-variant='secondary']:focus-visible {
    background-color: ${({tokens:t})=>t.theme.foregroundSecondary};
  }

  button[data-size='xs'] > wui-icon {
    width: 8px;
    height: 8px;
  }

  button[data-size='sm'] > wui-icon {
    width: 12px;
    height: 12px;
  }

  button[data-size='xs'],
  button[data-size='sm'] {
    border-radius: ${({borderRadius:t})=>t[1]};
  }

  button[data-size='md'],
  button[data-size='lg'] {
    border-radius: ${({borderRadius:t})=>t[2]};
  }

  button[data-size='md'] > wui-icon {
    width: 16px;
    height: 16px;
  }

  button[data-size='lg'] > wui-icon {
    width: 20px;
    height: 20px;
  }

  button:disabled {
    background-color: transparent;
    cursor: not-allowed;
    opacity: 0.5;
  }

  button:hover:not(:disabled) {
    background-color: var(--wui-color-accent-glass-015);
  }

  button:focus-visible:not(:disabled) {
    background-color: var(--wui-color-accent-glass-015);
    box-shadow:
      inset 0 0 0 1px var(--wui-color-accent-100),
      0 0 0 4px var(--wui-color-accent-glass-020);
  }
`},6205,[4659]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0});var n=r(d[0]);Object.keys(n).forEach(function(t){"default"!==t&&"__esModule"!==t&&(t in e&&e[t]===n[t]||Object.defineProperty(e,t,{enumerable:!0,get:function(){return n[t]}}))})},6206,[4731]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0});var n=r(d[0]);Object.keys(n).forEach(function(t){"default"!==t&&"__esModule"!==t&&(t in e&&e[t]===n[t]||Object.defineProperty(e,t,{enumerable:!0,get:function(){return n[t]}}))})},6207,[6208]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.WuiNetworkImage=void 0;var i=_r(_d[1]),r=_r(_d[2]),o=_r(_d[3]),s=_r(_d[4]),n=_r(_d[5]);_r(_d[6]),_r(_d[7]);var l=_r(_d[8]),p=_r(_d[9]),c=t(_r(_d[10])),h=this&&this.__decorate||function(t,i,r,o){var s,n=arguments.length,l=n<3?i:null===o?o=Object.getOwnPropertyDescriptor(i,r):o;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)l=Reflect.decorate(t,i,r,o);else for(var p=t.length-1;p>=0;p--)(s=t[p])&&(l=(n<3?s(l):n>3?s(i,r,l):s(i,r))||l);return n>3&&l&&Object.defineProperty(i,r,l),l};let d=e.WuiNetworkImage=class extends i.LitElement{constructor(){super(...arguments),this.size='md',this.name='uknown',this.networkImagesBySize={sm:n.networkSvgSm,md:s.networkSvgMd,lg:o.networkSvgLg},this.selected=!1,this.round=!1}render(){const t={sm:'4',md:'6',lg:'10'};return this.round?(this.dataset.round='true',this.style.cssText="\n      --local-width: var(--apkt-spacing-10);\n      --local-height: var(--apkt-spacing-10);\n      --local-icon-size: var(--apkt-spacing-4);\n    "):this.style.cssText=`\n\n      --local-path: var(--apkt-path-network-${this.size});\n      --local-width:  var(--apkt-width-network-${this.size});\n      --local-height:  var(--apkt-height-network-${this.size});\n      --local-icon-size:  var(--apkt-spacing-${t[this.size]});\n    `,i.html`${this.templateVisual()} ${this.svgTemplate()} `}svgTemplate(){return this.round?null:this.networkImagesBySize[this.size]}templateVisual(){return this.imageSrc?i.html`<wui-image src=${this.imageSrc} alt=${this.name}></wui-image>`:i.html`<wui-icon size="inherit" color="default" name="networkPlaceholder"></wui-icon>`}};d.styles=[l.resetStyles,c.default],h([(0,r.property)()],d.prototype,"size",void 0),h([(0,r.property)()],d.prototype,"name",void 0),h([(0,r.property)({type:Object})],d.prototype,"networkImagesBySize",void 0),h([(0,r.property)()],d.prototype,"imageSrc",void 0),h([(0,r.property)({type:Boolean})],d.prototype,"selected",void 0),h([(0,r.property)({type:Boolean})],d.prototype,"round",void 0),e.WuiNetworkImage=d=h([(0,p.customElement)('wui-network-image')],d)},6208,[2,4653,4674,6209,4756,6210,4692,4731,4652,4663,6211]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.networkSvgLg=void 0;var t=r(d[0]);e.networkSvgLg=t.svg`<svg width="86" height="96" fill="none">
  <path
    d="M78.3244 18.926L50.1808 2.45078C45.7376 -0.150261 40.2624 -0.150262 35.8192 2.45078L7.6756 18.926C3.23322 21.5266 0.5 26.3301 0.5 31.5248V64.4752C0.5 69.6699 3.23322 74.4734 7.6756 77.074L35.8192 93.5492C40.2624 96.1503 45.7376 96.1503 50.1808 93.5492L78.3244 77.074C82.7668 74.4734 85.5 69.6699 85.5 64.4752V31.5248C85.5 26.3301 82.7668 21.5266 78.3244 18.926Z"
  />
</svg>`},6209,[4653]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.networkSvgSm=void 0;var v=r(d[0]);e.networkSvgSm=v.svg`
  <svg fill="none" viewBox="0 0 36 40">
    <path
      d="M15.4 2.1a5.21 5.21 0 0 1 5.2 0l11.61 6.7a5.21 5.21 0 0 1 2.61 4.52v13.4c0 1.87-1 3.59-2.6 4.52l-11.61 6.7c-1.62.93-3.6.93-5.22 0l-11.6-6.7a5.21 5.21 0 0 1-2.61-4.51v-13.4c0-1.87 1-3.6 2.6-4.52L15.4 2.1Z"
    />
  </svg>
`},6210,[4653]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var t=r(d[0]);e.default=t.css`
  :host {
    position: relative;
    border-radius: inherit;
    display: flex;
    justify-content: center;
    align-items: center;
    width: var(--local-width);
    height: var(--local-height);
  }

  :host([data-round='true']) {
    background: ${({tokens:t})=>t.theme.foregroundPrimary};
    border-radius: 100%;
    outline: 1px solid ${({tokens:t})=>t.core.glass010};
  }

  svg {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    z-index: 1;
  }

  svg > path {
    stroke: var(--local-stroke);
  }

  wui-image {
    width: 100%;
    height: 100%;
    -webkit-clip-path: var(--local-path);
    clip-path: var(--local-path);
    background: ${({tokens:t})=>t.theme.foregroundPrimary};
  }

  wui-icon {
    transform: translateY(-5%);
    width: var(--local-icon-size);
    height: var(--local-icon-size);
  }
`},6211,[4659]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0});var n=r(d[0]);Object.keys(n).forEach(function(t){"default"!==t&&"__esModule"!==t&&(t in e&&e[t]===n[t]||Object.defineProperty(e,t,{enumerable:!0,get:function(){return n[t]}}))})},6212,[6213]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.WuiSeparator=void 0;var r=_r(_d[1]),o=_r(_d[2]);_r(_d[3]);var l=_r(_d[4]),i=_r(_d[5]),s=t(_r(_d[6])),n=this&&this.__decorate||function(t,r,o,l){var i,s=arguments.length,n=s<3?r:null===l?l=Object.getOwnPropertyDescriptor(r,o):l;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)n=Reflect.decorate(t,r,o,l);else for(var p=t.length-1;p>=0;p--)(i=t[p])&&(n=(s<3?i(n):s>3?i(r,o,n):i(r,o))||n);return s>3&&n&&Object.defineProperty(r,o,n),n};let p=e.WuiSeparator=class extends r.LitElement{constructor(){super(...arguments),this.text='',this.bgColor='primary'}render(){return this.dataset.bgColor=this.bgColor,r.html`${this.template()}`}template(){return this.text?r.html`<wui-text variant="md-regular" color="secondary">${this.text}</wui-text>`:null}};p.styles=[l.resetStyles,s.default],n([(0,o.property)()],p.prototype,"text",void 0),n([(0,o.property)()],p.prototype,"bgColor",void 0),e.WuiSeparator=p=n([(0,i.customElement)('wui-separator')],p)},6213,[2,4653,4674,4722,4652,4663,6214]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var o=r(d[0]);e.default=o.css`
  :host {
    position: relative;
    display: flex;
    width: 100%;
    height: 1px;
    background-color: ${({tokens:o})=>o.theme.borderPrimary};
    justify-content: center;
    align-items: center;
  }

  :host > wui-text {
    position: absolute;
    padding: 0px 8px;
    transition: background-color ${({durations:o})=>o.lg}
      ${({easings:o})=>o['ease-out-power-2']};
    will-change: background-color;
  }

  :host([data-bg-color='primary']) > wui-text {
    background-color: ${({tokens:o})=>o.theme.backgroundPrimary};
  }

  :host([data-bg-color='secondary']) > wui-text {
    background-color: ${({tokens:o})=>o.theme.foregroundPrimary};
  }
`},6214,[4659]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.PayController=e.DIRECT_TRANSFER_TRANSACTION_TYPE=e.DIRECT_TRANSFER_REQUEST_ID=e.DIRECT_TRANSFER_DEPOSIT_TYPE=void 0;var t=r(d[0]),s=r(d[1]),n=r(d[2]),o=r(d[3]),c=r(d[4]),p=r(d[5]),y=r(d[6]),E=r(d[7]),u=r(d[8]),l=r(d[9]);const A='unknown',P=e.DIRECT_TRANSFER_REQUEST_ID='direct-transfer',h=(e.DIRECT_TRANSFER_DEPOSIT_TYPE='deposit',e.DIRECT_TRANSFER_TRANSACTION_TYPE='transaction',(0,t.proxy)({paymentAsset:{network:'eip155:1',asset:'0x0',metadata:{name:'0x0',symbol:'0x0',decimals:0}},recipient:'0x0',amount:0,isConfigured:!1,error:null,isPaymentInProgress:!1,exchanges:[],isLoading:!1,openInNewTab:!0,redirectUrl:void 0,payWithExchange:void 0,currentPayment:void 0,analyticsSet:!1,paymentId:void 0,choice:'pay',tokenBalances:{[n.ConstantsUtil.CHAIN.EVM]:[],[n.ConstantsUtil.CHAIN.SOLANA]:[]},isFetchingTokenBalances:!1,selectedPaymentAsset:null,quote:void 0,quoteStatus:'waiting',quoteError:null,isFetchingQuote:!1,selectedExchange:void 0,exchangeUrlForQuote:void 0,requestId:void 0})),w=e.PayController={state:h,subscribe:s=>(0,t.subscribe)(h,()=>s(h)),subscribeKey:(t,n)=>(0,s.subscribeKey)(h,t,n),async handleOpenPay(t){this.resetState(),this.setPaymentConfig(t),this.initializeAnalytics(),(0,l.ensureCorrectAddress)(),await this.prepareTokenLogo(),h.isConfigured=!0,o.EventsController.sendEvent({type:'track',event:'PAY_MODAL_OPEN',properties:{exchanges:h.exchanges,configuration:{network:h.paymentAsset.network,asset:h.paymentAsset.asset,recipient:h.recipient,amount:h.amount}}}),await o.ModalController.open({view:'Pay'})},resetState(){h.paymentAsset={network:'eip155:1',asset:'0x0',metadata:{name:'0x0',symbol:'0x0',decimals:0}},h.recipient='0x0',h.amount=0,h.isConfigured=!1,h.error=null,h.isPaymentInProgress=!1,h.isLoading=!1,h.currentPayment=void 0,h.selectedExchange=void 0,h.exchangeUrlForQuote=void 0,h.requestId=void 0},resetQuoteState(){h.quote=void 0,h.quoteStatus='waiting',h.quoteError=null,h.isFetchingQuote=!1,h.requestId=void 0},setPaymentConfig(t){if(!t.paymentAsset)throw new y.AppKitPayError(y.AppKitPayErrorCodes.INVALID_PAYMENT_CONFIG);try{h.choice=t.choice??'pay',h.paymentAsset=t.paymentAsset,h.recipient=t.recipient,h.amount=t.amount,h.openInNewTab=t.openInNewTab??!0,h.redirectUrl=t.redirectUrl,h.payWithExchange=t.payWithExchange,h.error=null}catch(t){throw new y.AppKitPayError(y.AppKitPayErrorCodes.INVALID_PAYMENT_CONFIG,t.message)}},setSelectedPaymentAsset(t){h.selectedPaymentAsset=t},setSelectedExchange(t){h.selectedExchange=t},setRequestId(t){h.requestId=t},setPaymentInProgress(t){h.isPaymentInProgress=t},getPaymentAsset:()=>h.paymentAsset,getExchanges:()=>h.exchanges,async fetchExchanges(){try{h.isLoading=!0;const t=await(0,E.getExchanges)({page:0});h.exchanges=t.exchanges.slice(0,2)}catch(t){throw o.SnackController.showError(y.AppKitPayErrorMessages.UNABLE_TO_GET_EXCHANGES),new y.AppKitPayError(y.AppKitPayErrorCodes.UNABLE_TO_GET_EXCHANGES)}finally{h.isLoading=!1}},async getAvailableExchanges(t){try{const s=t?.asset&&t?.network?(0,u.formatCaip19Asset)(t.network,t.asset):void 0;return await(0,E.getExchanges)({page:t?.page??0,asset:s,amount:t?.amount?.toString()})}catch(t){throw new y.AppKitPayError(y.AppKitPayErrorCodes.UNABLE_TO_GET_EXCHANGES)}},async getPayUrl(t,s,n=!1){try{const c=Number(s.amount),p=await(0,E.getPayUrl)({exchangeId:t,asset:(0,u.formatCaip19Asset)(s.network,s.asset),amount:c.toString(),recipient:`${s.network}:${s.recipient}`});return o.EventsController.sendEvent({type:'track',event:'PAY_EXCHANGE_SELECTED',properties:{source:'pay',exchange:{id:t},configuration:{network:s.network,asset:s.asset,recipient:s.recipient,amount:c},currentPayment:{type:'exchange',exchangeId:t},headless:n}}),n&&(this.initiatePayment(),o.EventsController.sendEvent({type:'track',event:'PAY_INITIATED',properties:{source:'pay',paymentId:h.paymentId||A,configuration:{network:s.network,asset:s.asset,recipient:s.recipient,amount:c},currentPayment:{type:'exchange',exchangeId:t}}})),p}catch(t){if(t instanceof Error&&t.message.includes('is not supported'))throw new y.AppKitPayError(y.AppKitPayErrorCodes.ASSET_NOT_SUPPORTED);throw new Error(t.message)}},async generateExchangeUrlForQuote({exchangeId:t,paymentAsset:s,amount:n,recipient:o}){const c=await(0,E.getPayUrl)({exchangeId:t,asset:(0,u.formatCaip19Asset)(s.network,s.asset),amount:n.toString(),recipient:o});h.exchangeSessionId=c.sessionId,h.exchangeUrlForQuote=c.url},async openPayUrl(t,s,n=!1){try{const c=await this.getPayUrl(t.exchangeId,s,n);if(!c)throw new y.AppKitPayError(y.AppKitPayErrorCodes.UNABLE_TO_GET_PAY_URL);const p=t.openInNewTab??!0?'_blank':'_self';return o.CoreHelperUtil.openHref(c.url,p),c}catch(t){throw t instanceof y.AppKitPayError?h.error=t.message:h.error=y.AppKitPayErrorMessages.GENERIC_PAYMENT_ERROR,new y.AppKitPayError(y.AppKitPayErrorCodes.UNABLE_TO_GET_PAY_URL)}},async onTransfer({chainNamespace:t,fromAddress:s,toAddress:c,amount:E,paymentAsset:u}){if(h.currentPayment={type:'wallet',status:'IN_PROGRESS'},!h.isPaymentInProgress)try{this.initiatePayment();const A=o.ChainController.getAllRequestedCaipNetworks().find(t=>t.caipNetworkId===u.network);if(!A)throw new Error('Target network not found');const P=o.ChainController.state.activeCaipNetwork;switch(p.HelpersUtil.isLowerCaseMatch(P?.caipNetworkId,A.caipNetworkId)||await o.ChainController.switchActiveNetwork(A),t){case n.ConstantsUtil.CHAIN.EVM:'native'===u.asset&&(h.currentPayment.result=await(0,l.processEvmNativePayment)(u,t,{recipient:c,amount:E,fromAddress:s})),u.asset.startsWith('0x')&&(h.currentPayment.result=await(0,l.processEvmErc20Payment)(u,{recipient:c,amount:E,fromAddress:s})),h.currentPayment.status='SUCCESS';break;case n.ConstantsUtil.CHAIN.SOLANA:h.currentPayment.result=await(0,l.processSolanaPayment)(t,{recipient:c,amount:E,fromAddress:s,tokenMint:'native'===u.asset?void 0:u.asset}),h.currentPayment.status='SUCCESS';break;default:throw new y.AppKitPayError(y.AppKitPayErrorCodes.INVALID_CHAIN_NAMESPACE)}}catch(t){throw t instanceof y.AppKitPayError?h.error=t.message:h.error=y.AppKitPayErrorMessages.GENERIC_PAYMENT_ERROR,h.currentPayment.status='FAILED',o.SnackController.showError(h.error),t}finally{h.isPaymentInProgress=!1}},async onSendTransaction(t){try{const{namespace:s,transactionStep:c}=t;w.initiatePayment();const y=o.ChainController.getAllRequestedCaipNetworks().find(t=>t.caipNetworkId===h.paymentAsset?.network);if(!y)throw new Error('Target network not found');const E=o.ChainController.state.activeCaipNetwork;if(p.HelpersUtil.isLowerCaseMatch(E?.caipNetworkId,y.caipNetworkId)||await o.ChainController.switchActiveNetwork(y),s===n.ConstantsUtil.CHAIN.EVM){const{from:t,to:n,data:p,value:y}=c.transaction;await o.ConnectionController.sendTransaction({address:t,to:n,data:p,value:BigInt(y),chainNamespace:s})}else if(s===n.ConstantsUtil.CHAIN.SOLANA){const{instructions:t}=c.transaction;await o.ConnectionController.writeSolanaTransaction({instructions:t})}}catch(t){throw t instanceof y.AppKitPayError?h.error=t.message:h.error=y.AppKitPayErrorMessages.GENERIC_PAYMENT_ERROR,o.SnackController.showError(h.error),t}finally{h.isPaymentInProgress=!1}},getExchangeById:t=>h.exchanges.find(s=>s.id===t),validatePayConfig(t){const{paymentAsset:s,recipient:n,amount:o}=t;if(!s)throw new y.AppKitPayError(y.AppKitPayErrorCodes.INVALID_PAYMENT_CONFIG);if(!n)throw new y.AppKitPayError(y.AppKitPayErrorCodes.INVALID_RECIPIENT);if(!s.asset)throw new y.AppKitPayError(y.AppKitPayErrorCodes.INVALID_ASSET);if(null==o||o<=0)throw new y.AppKitPayError(y.AppKitPayErrorCodes.INVALID_AMOUNT)},async handlePayWithExchange(t){try{h.currentPayment={type:'exchange',exchangeId:t};const{network:s,asset:n}=h.paymentAsset,o={network:s,asset:n,amount:h.amount,recipient:h.recipient},c=await this.getPayUrl(t,o);if(!c)throw new y.AppKitPayError(y.AppKitPayErrorCodes.UNABLE_TO_INITIATE_PAYMENT);return h.currentPayment.sessionId=c.sessionId,h.currentPayment.status='IN_PROGRESS',h.currentPayment.exchangeId=t,this.initiatePayment(),{url:c.url,openInNewTab:h.openInNewTab}}catch(t){return t instanceof y.AppKitPayError?h.error=t.message:h.error=y.AppKitPayErrorMessages.GENERIC_PAYMENT_ERROR,h.isPaymentInProgress=!1,o.SnackController.showError(h.error),null}},async getBuyStatus(t,s){try{const n=await(0,E.getBuyStatus)({sessionId:s,exchangeId:t});return'SUCCESS'!==n.status&&'FAILED'!==n.status||o.EventsController.sendEvent({type:'track',event:'SUCCESS'===n.status?'PAY_SUCCESS':'PAY_ERROR',properties:{message:'FAILED'===n.status?o.CoreHelperUtil.parseError(h.error):void 0,source:'pay',paymentId:h.paymentId||A,configuration:{network:h.paymentAsset.network,asset:h.paymentAsset.asset,recipient:h.recipient,amount:h.amount},currentPayment:{type:'exchange',exchangeId:h.currentPayment?.exchangeId,sessionId:h.currentPayment?.sessionId,result:n.txHash}}}),n}catch(t){throw new y.AppKitPayError(y.AppKitPayErrorCodes.UNABLE_TO_GET_BUY_STATUS)}},async fetchTokensFromEOA({caipAddress:t,caipNetwork:s,namespace:o}){if(!t)return[];const{address:p}=n.ParseUtil.parseCaipAddress(t);let y=s;o===n.ConstantsUtil.CHAIN.EVM&&(y=void 0);return await c.BalanceUtil.getMyTokensWithBalance({address:p,caipNetwork:y})},async fetchTokensFromExchange(){if(!h.selectedExchange)return[];const t=await(0,E.getAssetsForExchange)(h.selectedExchange.id),s=Object.values(t.assets).flat();return await Promise.all(s.map(async t=>{const s=(0,u.formatPaymentAssetToBalance)(t),{chainNamespace:c}=n.ParseUtil.parseCaipNetworkId(s.chainId);let p=s.address;if(o.CoreHelperUtil.isCaipAddress(p)){const{address:t}=n.ParseUtil.parseCaipAddress(p);p=t}const y=await o.AssetUtil.getImageByToken(p??'',c).catch(()=>{});return s.iconUrl=y??'',s}))},async fetchTokens({caipAddress:t,caipNetwork:s,namespace:n}){try{h.isFetchingTokenBalances=!0;const o=Boolean(h.selectedExchange)?this.fetchTokensFromExchange():this.fetchTokensFromEOA({caipAddress:t,caipNetwork:s,namespace:n}),c=await o;h.tokenBalances=Object.assign({},h.tokenBalances,{[n]:c})}catch(t){const s=t instanceof Error?t.message:'Unable to get token balances';o.SnackController.showError(s)}finally{h.isFetchingTokenBalances=!1}},async fetchQuote({amount:t,address:s,sourceToken:c,toToken:p,recipient:u}){try{w.resetQuoteState(),h.isFetchingQuote=!0;const o=await(0,E.getQuote)({amount:t,address:h.selectedExchange?void 0:s,sourceToken:c,toToken:p,recipient:u});if(h.selectedExchange){const t=(0,l.getTransferStep)(o);if(t){const s=`${c.network}:${t.deposit.receiver}`,o=n.NumberUtil.formatNumber(t.deposit.amount,{decimals:c.metadata.decimals??0,round:8});await w.generateExchangeUrlForQuote({exchangeId:h.selectedExchange.id,paymentAsset:c,amount:o.toString(),recipient:s})}}h.quote=o}catch(t){let s=y.AppKitPayErrorMessages.UNABLE_TO_GET_QUOTE;if(t instanceof Error&&t.cause&&t.cause instanceof Response)try{const n=await t.cause.json();n.error&&'string'==typeof n.error&&(s=n.error)}catch{}throw h.quoteError=s,o.SnackController.showError(s),new y.AppKitPayError(y.AppKitPayErrorCodes.UNABLE_TO_GET_QUOTE)}finally{h.isFetchingQuote=!1}},async fetchQuoteStatus({requestId:t}){try{if(t===P){const t=h.selectedExchange,s=h.exchangeSessionId;if(t&&s){switch((await this.getBuyStatus(t.id,s)).status){case'IN_PROGRESS':case'UNKNOWN':default:h.quoteStatus='waiting';break;case'SUCCESS':h.quoteStatus='success',h.isPaymentInProgress=!1;break;case'FAILED':h.quoteStatus='failure',h.isPaymentInProgress=!1}return}return void(h.quoteStatus='success')}const{status:s}=await(0,E.getQuoteStatus)({requestId:t});h.quoteStatus=s}catch{throw h.quoteStatus='failure',new y.AppKitPayError(y.AppKitPayErrorCodes.UNABLE_TO_GET_QUOTE_STATUS)}},initiatePayment(){h.isPaymentInProgress=!0,h.paymentId=crypto.randomUUID()},initializeAnalytics(){h.analyticsSet||(h.analyticsSet=!0,this.subscribeKey('isPaymentInProgress',t=>{if(h.currentPayment?.status&&'UNKNOWN'!==h.currentPayment.status){const t={IN_PROGRESS:'PAY_INITIATED',SUCCESS:'PAY_SUCCESS',FAILED:'PAY_ERROR'}[h.currentPayment.status];o.EventsController.sendEvent({type:'track',event:t,properties:{message:'FAILED'===h.currentPayment.status?o.CoreHelperUtil.parseError(h.error):void 0,source:'pay',paymentId:h.paymentId||A,configuration:{network:h.paymentAsset.network,asset:h.paymentAsset.asset,recipient:h.recipient,amount:h.amount},currentPayment:{type:h.currentPayment.type,exchangeId:h.currentPayment.exchangeId,sessionId:h.currentPayment.sessionId,result:h.currentPayment.result}}})}}))},async prepareTokenLogo(){if(!h.paymentAsset.metadata.logoURI)try{const{chainNamespace:t}=n.ParseUtil.parseCaipNetworkId(h.paymentAsset.network),s=await o.AssetUtil.getImageByToken(h.paymentAsset.asset,t);h.paymentAsset.metadata.logoURI=s}catch{}}}},6215,[4581,4583,4556,4632,6216,4664,6218,6219,6222,6221]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),Object.defineProperty(e,"AssetUtil",{enumerable:!0,get:function(){return t.AssetUtil}}),Object.defineProperty(e,"BalanceUtil",{enumerable:!0,get:function(){return f.BalanceUtil}}),Object.defineProperty(e,"ConstantsUtil",{enumerable:!0,get:function(){return n.ConstantsUtil}}),Object.defineProperty(e,"CoreHelperUtil",{enumerable:!0,get:function(){return o.CoreHelperUtil}}),Object.defineProperty(e,"FetchUtil",{enumerable:!0,get:function(){return p.FetchUtil}}),Object.defineProperty(e,"OptionsUtil",{enumerable:!0,get:function(){return l.OptionsUtil}}),Object.defineProperty(e,"RouterUtil",{enumerable:!0,get:function(){return u.RouterUtil}}),Object.defineProperty(e,"SIWXUtil",{enumerable:!0,get:function(){return b.SIWXUtil}}),Object.defineProperty(e,"StorageUtil",{enumerable:!0,get:function(){return c.StorageUtil}}),Object.defineProperty(e,"connectFarcaster",{enumerable:!0,get:function(){return U.connectFarcaster}}),Object.defineProperty(e,"connectSocial",{enumerable:!0,get:function(){return U.connectSocial}}),Object.defineProperty(e,"executeSocialLogin",{enumerable:!0,get:function(){return U.executeSocialLogin}}),Object.defineProperty(e,"getChainsToDisconnect",{enumerable:!0,get:function(){return s.getChainsToDisconnect}});var t=r(d[0]),n=r(d[1]),o=r(d[2]),c=r(d[3]),u=r(d[4]),l=r(d[5]),f=r(d[6]),b=r(d[7]),p=r(d[8]),U=r(d[9]),s=r(d[10])},6216,[4614,4585,4584,4586,4648,4605,4601,4640,4603,6217,4608]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.connectFarcaster=f,e.connectSocial=v,e.executeSocialLogin=async function(o){n.ChainController.setAccountProp('socialProvider',o,n.ChainController.state.activeChain),c.EventsController.sendEvent({type:'track',event:'SOCIAL_LOGIN_STARTED',properties:{provider:o}}),'farcaster'===o?await f():await v(o)};var o=r(d[0]),t=r(d[1]),n=r(d[2]),l=r(d[3]),c=r(d[4]),s=r(d[5]),C=r(d[6]),p=r(d[7]),u=r(d[8]);function h(){try{return p.CoreHelperUtil.returnOpenHref(`${t.ConstantsUtil.SECURE_SITE_SDK_ORIGIN}/loading`,'popupWindow','width=600,height=800,scrollbars=yes')}catch(o){throw new Error('Could not open social popup')}}async function f(){s.RouterController.push('ConnectingFarcaster');const o=l.ConnectorController.getAuthConnector();if(o){const t=n.ChainController.getAccountData();if(!t?.farcasterUrl)try{const{url:t}=await o.provider.getFarcasterUri();n.ChainController.setAccountProp('farcasterUrl',t,n.ChainController.state.activeChain)}catch(o){s.RouterController.goBack(),C.SnackController.showError(o)}}}async function v(t){s.RouterController.push('ConnectingSocial');const f=l.ConnectorController.getAuthConnector();let v=null;try{const l=setTimeout(()=>{throw new Error('Social login timed out. Please try again.')},45e3);if(f&&t){if(p.CoreHelperUtil.isTelegram()||(v=h()),v)n.ChainController.setAccountProp('socialWindow',(0,o.ref)(v),n.ChainController.state.activeChain);else if(!p.CoreHelperUtil.isTelegram())throw new Error('Could not create social popup');const{uri:c}=await f.provider.getSocialRedirectUri({provider:t});if(!c)throw v?.close(),new Error('Could not fetch the social redirect uri');if(v&&(v.location.href=c),p.CoreHelperUtil.isTelegram()){u.StorageUtil.setTelegramSocialProvider(t);const o=p.CoreHelperUtil.formatTelegramSocialLoginUrl(c);p.CoreHelperUtil.openHref(o,'_top')}clearTimeout(l)}}catch(o){v?.close();const n=p.CoreHelperUtil.parseError(o);C.SnackController.showError(n),c.EventsController.sendEvent({type:'track',event:'SOCIAL_LOGIN_ERROR',properties:{provider:t,message:n}})}}},6217,[4581,4556,4588,4611,4619,4621,4606,4584,4586]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.AppKitPayErrorMessages=e.AppKitPayErrorCodes=e.AppKitPayError=void 0,e.createAppKitPayError=function(E,T){const N=E||_.UNKNOWN_ERROR;return new A(N,T)};const _=e.AppKitPayErrorCodes={INVALID_PAYMENT_CONFIG:'INVALID_PAYMENT_CONFIG',INVALID_RECIPIENT:'INVALID_RECIPIENT',INVALID_ASSET:'INVALID_ASSET',INVALID_AMOUNT:'INVALID_AMOUNT',UNKNOWN_ERROR:'UNKNOWN_ERROR',UNABLE_TO_INITIATE_PAYMENT:'UNABLE_TO_INITIATE_PAYMENT',INVALID_CHAIN_NAMESPACE:'INVALID_CHAIN_NAMESPACE',GENERIC_PAYMENT_ERROR:'GENERIC_PAYMENT_ERROR',UNABLE_TO_GET_EXCHANGES:'UNABLE_TO_GET_EXCHANGES',ASSET_NOT_SUPPORTED:'ASSET_NOT_SUPPORTED',UNABLE_TO_GET_PAY_URL:'UNABLE_TO_GET_PAY_URL',UNABLE_TO_GET_BUY_STATUS:'UNABLE_TO_GET_BUY_STATUS',UNABLE_TO_GET_TOKEN_BALANCES:'UNABLE_TO_GET_TOKEN_BALANCES',UNABLE_TO_GET_QUOTE:'UNABLE_TO_GET_QUOTE',UNABLE_TO_GET_QUOTE_STATUS:'UNABLE_TO_GET_QUOTE_STATUS',INVALID_RECIPIENT_ADDRESS_FOR_ASSET:'INVALID_RECIPIENT_ADDRESS_FOR_ASSET'},E=e.AppKitPayErrorMessages={[_.INVALID_PAYMENT_CONFIG]:'Invalid payment configuration',[_.INVALID_RECIPIENT]:'Invalid recipient address',[_.INVALID_ASSET]:'Invalid asset specified',[_.INVALID_AMOUNT]:'Invalid payment amount',[_.INVALID_RECIPIENT_ADDRESS_FOR_ASSET]:'Invalid recipient address for the asset selected',[_.UNKNOWN_ERROR]:'Unknown payment error occurred',[_.UNABLE_TO_INITIATE_PAYMENT]:'Unable to initiate payment',[_.INVALID_CHAIN_NAMESPACE]:'Invalid chain namespace',[_.GENERIC_PAYMENT_ERROR]:'Unable to process payment',[_.UNABLE_TO_GET_EXCHANGES]:'Unable to get exchanges',[_.ASSET_NOT_SUPPORTED]:'Asset not supported by the selected exchange',[_.UNABLE_TO_GET_PAY_URL]:'Unable to get payment URL',[_.UNABLE_TO_GET_BUY_STATUS]:'Unable to get buy status',[_.UNABLE_TO_GET_TOKEN_BALANCES]:'Unable to get token balances',[_.UNABLE_TO_GET_QUOTE]:'Unable to get quote. Please choose a different token',[_.UNABLE_TO_GET_QUOTE_STATUS]:'Unable to get quote status'};class A extends Error{get message(){return E[this.code]}constructor(_,T){super(E[_]),this.name='AppKitPayError',this.code=_,this.details=T,Error.captureStackTrace&&Error.captureStackTrace(this,A)}}e.AppKitPayError=A},6218,[]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.getApiUrl=l,e.getAssetsForExchange=async function(t){return await u.get({path:`/appkit/v1/transfers/assets/exchanges/${t}`,params:k()})},e.getBuyStatus=async function(t){return(await h('reown_getExchangeBuyStatus',t)).result},e.getExchanges=async function(t){return(await h('reown_getExchanges',t)).result},e.getPayUrl=async function(t){return(await h('reown_getExchangePayUrl',t)).result},e.getQuote=async function(t){const n=s.HelpersUtil.isLowerCaseMatch(t.sourceToken.network,t.toToken.network),o=s.HelpersUtil.isLowerCaseMatch(t.sourceToken.asset,t.toToken.asset);if(n&&o)return(0,c.getDirectTransferQuote)(t);return w(t)},e.getQuoteStatus=async function(t){return await u.get({path:'/appkit/v1/transfers/status',params:Object.assign({requestId:t.requestId},k())})},e.getTransfersQuote=w;var t=r(d[0]),n=r(d[1]),s=r(d[2]),o=r(d[3]),c=r(d[4]);const u=new n.FetchUtil({baseUrl:n.CoreHelperUtil.getApiUrl(),clientId:null});class p extends Error{}function l(){const t=n.OptionsController.getSnapshot().projectId;return`${o.API_URL}?projectId=${t}`}function k(){const{projectId:t,sdkType:s,sdkVersion:o}=n.OptionsController.state;return{projectId:t,st:s||'appkit',sv:o||'html-wagmi-4.2.2'}}async function h(t,s){const o=l(),{sdkType:c,sdkVersion:u,projectId:k}=n.OptionsController.getSnapshot(),h={jsonrpc:'2.0',id:1,method:t,params:Object.assign({},s||{},{st:c,sv:u,projectId:k})},w=await fetch(o,{method:'POST',body:JSON.stringify(h),headers:{'Content-Type':'application/json'}}),f=await w.json();if(f.error)throw new p(f.error.message);return f}async function w(s){const o=t.NumberUtil.bigNumber(s.amount).times(10**s.toToken.metadata.decimals).toString(),{chainId:c,chainNamespace:p}=t.ParseUtil.parseCaipNetworkId(s.sourceToken.network),{chainId:l,chainNamespace:h}=t.ParseUtil.parseCaipNetworkId(s.toToken.network),w='native'===s.sourceToken.asset?(0,n.getNativeTokenAddress)(p):s.sourceToken.asset,f='native'===s.toToken.asset?(0,n.getNativeTokenAddress)(h):s.toToken.asset;return await u.post({path:'/appkit/v1/transfers/quote',body:{user:s.address,originChainId:c.toString(),originCurrency:w,destinationChainId:l.toString(),destinationCurrency:f,recipient:s.recipient,amount:o},params:k()})}},6219,[4556,4632,4664,6220,6221]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.REOWN_TEST_EXCHANGE_ID=e.API_URL=void 0;e.API_URL='https://rpc.walletconnect.org/v1/json-rpc',e.REOWN_TEST_EXCHANGE_ID='reown_test'},6220,[]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.ensureCorrectAddress=function(){const{chainNamespace:p}=t.ParseUtil.parseCaipNetworkId(n.PayController.state.paymentAsset.network);if(!o.CoreHelperUtil.isAddress(n.PayController.state.recipient,p))throw new s.AppKitPayError(s.AppKitPayErrorCodes.INVALID_RECIPIENT_ADDRESS_FOR_ASSET,`Provide valid recipient address for namespace "${p}"`)},e.ensureCorrectNetwork=async function(t){const{paymentAssetNetwork:n,activeCaipNetwork:p,approvedCaipNetworkIds:E,requestedCaipNetworks:A}=t,c=o.CoreHelperUtil.sortRequestedNetworks(E,A).find(t=>t.caipNetworkId===n);if(!c)throw new s.AppKitPayError(s.AppKitPayErrorCodes.INVALID_PAYMENT_CONFIG);if(c.caipNetworkId===p.caipNetworkId)return;const C=o.ChainController.getNetworkProp('supportsAllNetworks',c.chainNamespace);if(!E?.includes(c.caipNetworkId)&&!C)throw new s.AppKitPayError(s.AppKitPayErrorCodes.INVALID_PAYMENT_CONFIG);try{await o.ChainController.switchActiveNetwork(c)}catch(t){throw new s.AppKitPayError(s.AppKitPayErrorCodes.GENERIC_PAYMENT_ERROR,t)}},e.getDirectTransferQuote=async function({sourceToken:t,toToken:s,amount:p,recipient:E}){const A=o.ConnectionController.parseUnits(p,t.metadata.decimals),c=o.ConnectionController.parseUnits(p,s.metadata.decimals);return Promise.resolve({type:n.DIRECT_TRANSFER_REQUEST_ID,origin:{amount:A?.toString()??'0',currency:t},destination:{amount:c?.toString()??'0',currency:s},fees:[{id:'service',label:'Service Fee',amount:'0',currency:s}],steps:[{requestId:n.DIRECT_TRANSFER_REQUEST_ID,type:'deposit',deposit:{amount:A?.toString()??'0',currency:t.asset,receiver:E}}],timeInSeconds:6})},e.getTransactionsSteps=function(t,o=0){if(!t)return[];const s=t.steps.filter(t=>t.type===n.DIRECT_TRANSFER_TRANSACTION_TYPE),p=s.filter((t,n)=>n+1>o);return s.length>0&&s.length<3?p:[]},e.getTransferStep=function(t){if(!t)return null;const o=t.steps[0];if(!o||o.type!==n.DIRECT_TRANSFER_DEPOSIT_TYPE)return null;return o},e.processEvmErc20Payment=async function(n,p){if(!p.fromAddress)throw new s.AppKitPayError(s.AppKitPayErrorCodes.INVALID_PAYMENT_CONFIG,'fromAddress is required for ERC20 EVM payments.');const E=n.asset,A=p.recipient,c=Number(n.metadata.decimals),C=o.ConnectionController.parseUnits(p.amount.toString(),c);if(void 0===C)throw new s.AppKitPayError(s.AppKitPayErrorCodes.GENERIC_PAYMENT_ERROR);return await o.ConnectionController.writeContract({fromAddress:p.fromAddress,tokenAddress:E,args:[A,C],method:'transfer',abi:t.ContractUtil.getERC20Abi(E),chainNamespace:t.ConstantsUtil.CHAIN.EVM})??void 0},e.processEvmNativePayment=async function(n,p,E){if(p!==t.ConstantsUtil.CHAIN.EVM)throw new s.AppKitPayError(s.AppKitPayErrorCodes.INVALID_CHAIN_NAMESPACE);if(!E.fromAddress)throw new s.AppKitPayError(s.AppKitPayErrorCodes.INVALID_PAYMENT_CONFIG,'fromAddress is required for native EVM payments.');const A='string'==typeof E.amount?parseFloat(E.amount):E.amount;if(isNaN(A))throw new s.AppKitPayError(s.AppKitPayErrorCodes.INVALID_PAYMENT_CONFIG);const c=n.metadata?.decimals??18,C=o.ConnectionController.parseUnits(A.toString(),c);if('bigint'!=typeof C)throw new s.AppKitPayError(s.AppKitPayErrorCodes.GENERIC_PAYMENT_ERROR);return await o.ConnectionController.sendTransaction({chainNamespace:p,to:E.recipient,address:E.fromAddress,value:C,data:'0x'})??void 0},e.processSolanaPayment=async function(n,p){if(n!==t.ConstantsUtil.CHAIN.SOLANA)throw new s.AppKitPayError(s.AppKitPayErrorCodes.INVALID_CHAIN_NAMESPACE);if(!p.fromAddress)throw new s.AppKitPayError(s.AppKitPayErrorCodes.INVALID_PAYMENT_CONFIG,'fromAddress is required for Solana payments.');const E='string'==typeof p.amount?parseFloat(p.amount):p.amount;if(isNaN(E)||E<=0)throw new s.AppKitPayError(s.AppKitPayErrorCodes.INVALID_PAYMENT_CONFIG,'Invalid payment amount.');try{if(!o.ProviderController.getProvider(n))throw new s.AppKitPayError(s.AppKitPayErrorCodes.GENERIC_PAYMENT_ERROR,'No Solana provider available.');const A=await o.ConnectionController.sendTransaction({chainNamespace:t.ConstantsUtil.CHAIN.SOLANA,to:p.recipient,value:E,tokenMint:p.tokenMint});if(!A)throw new s.AppKitPayError(s.AppKitPayErrorCodes.GENERIC_PAYMENT_ERROR,'Transaction failed.');return A}catch(t){if(t instanceof s.AppKitPayError)throw t;throw new s.AppKitPayError(s.AppKitPayErrorCodes.GENERIC_PAYMENT_ERROR,`Solana payment failed: ${t}`)}};var t=r(d[0]),o=r(d[1]),n=r(d[2]),s=r(d[3])},6221,[4556,4632,6215,6218]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.formatAmount=function(n){const s=t.NumberUtil.bigNumber(n,{safe:!0});if(s.lt(.001))return'<0.001';return s.round(4).toString()},e.formatBalanceToPaymentAsset=function(o){const c=n.ChainController.getAllRequestedCaipNetworks().find(t=>t.caipNetworkId===o.chainId);let l=o.address;if(!c)throw new Error(`Target network not found for balance chainId "${o.chainId}"`);if(s.HelpersUtil.isLowerCaseMatch(o.symbol,c.nativeCurrency.symbol))l='native';else if(n.CoreHelperUtil.isCaipAddress(l)){const{address:n}=t.ParseUtil.parseCaipAddress(l);l=n}else if(!l)throw new Error(`Balance address not found for balance symbol "${o.symbol}"`);return{network:c.caipNetworkId,asset:l,metadata:{name:o.name,symbol:o.symbol,decimals:Number(o.quantity.decimals),logoURI:o.iconUrl},amount:o.quantity.numeric}},e.formatCaip19Asset=function(n,s){const{chainNamespace:o,chainId:u}=t.ParseUtil.parseCaipNetworkId(n),p=c[o];if(!p)throw new Error(`Unsupported chain namespace for CAIP-19 formatting: ${o}`);let f=p.native.assetNamespace,w=p.native.assetReference;'native'!==s?(f=p.defaultTokenNamespace,w=s):'eip155'===o&&l[u]&&(w=l[u]);return`${o}:${u}/${f}:${w}`},e.formatPaymentAssetToBalance=function(t){return{chainId:t.network,address:`${t.network}:${t.asset}`,symbol:t.metadata.symbol,name:t.metadata.name,iconUrl:t.metadata.logoURI||'',price:0,quantity:{numeric:'0',decimals:t.metadata.decimals.toString()}}},e.isPayWithWalletSupported=function(n){const{chainNamespace:s}=t.ParseUtil.parseCaipNetworkId(n);return o.includes(s)},e.isTestnetAsset=function(t){const s=n.ChainController.getAllRequestedCaipNetworks().find(n=>n.caipNetworkId===t.network);if(!s)return!1;return Boolean(s.testnet)};var t=r(d[0]),n=r(d[1]),s=r(d[2]);const o=['eip155','solana'],c={eip155:{native:{assetNamespace:'slip44',assetReference:'60'},defaultTokenNamespace:'erc20'},solana:{native:{assetNamespace:'slip44',assetReference:'501'},defaultTokenNamespace:'token'}},l={56:'714',204:'714'}},6222,[4556,4632,4664]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var t=r(d[0]);e.default=t.css`
  wui-separator {
    margin: var(--apkt-spacing-3) calc(var(--apkt-spacing-3) * -1) var(--apkt-spacing-2)
      calc(var(--apkt-spacing-3) * -1);
    width: calc(100% + var(--apkt-spacing-3) * 2);
  }

  .token-display {
    padding: var(--apkt-spacing-3) var(--apkt-spacing-3);
    border-radius: var(--apkt-borderRadius-5);
    background-color: var(--apkt-tokens-theme-backgroundPrimary);
    margin-top: var(--apkt-spacing-3);
    margin-bottom: var(--apkt-spacing-3);
  }

  .token-display wui-text {
    text-transform: none;
  }

  wui-loading-spinner {
    padding: var(--apkt-spacing-2);
  }

  .left-image-container {
    position: relative;
    justify-content: center;
    align-items: center;
  }

  .token-image {
    border-radius: ${({borderRadius:t})=>t.round};
    width: 40px;
    height: 40px;
  }

  .chain-image {
    position: absolute;
    width: 20px;
    height: 20px;
    bottom: -3px;
    right: -5px;
    border-radius: ${({borderRadius:t})=>t.round};
    border: 2px solid ${({tokens:t})=>t.theme.backgroundPrimary};
  }

  .payment-methods-container {
    background-color: ${({tokens:t})=>t.theme.foregroundPrimary};
    border-top-right-radius: ${({borderRadius:t})=>t[8]};
    border-top-left-radius: ${({borderRadius:t})=>t[8]};
  }
`},6223,[4650]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.W3mPayLoadingView=void 0;var i=_r(_d[1]),n=_r(_d[2]),s=_r(_d[3]),r=_r(_d[4]),o=_r(_d[5]),l=_r(_d[6]),u=_r(_d[7]);_r(_d[8]),_r(_d[9]),_r(_d[10]),_r(_d[11]),_r(_d[12]),_r(_d[13]);var c=_r(_d[14]),d=_r(_d[15]),p=_r(_d[16]),f=_r(_d[17]),h=t(_r(_d[18])),w=this&&this.__decorate||function(t,i,n,s){var r,o=arguments.length,l=o<3?i:null===s?s=Object.getOwnPropertyDescriptor(i,n):s;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)l=Reflect.decorate(t,i,n,s);else for(var u=t.length-1;u>=0;u--)(r=t[u])&&(l=(o<3?r(l):o>3?r(i,n,l):r(i,n))||l);return o>3&&l&&Object.defineProperty(i,n,l),l};const x={received:['pending','success','submitted'],processing:['success','submitted'],sending:['success','submitted']};let y=e.W3mPayLoadingView=class extends i.LitElement{constructor(){super(),this.unsubscribe=[],this.pollingInterval=null,this.paymentAsset=d.PayController.state.paymentAsset,this.quoteStatus=d.PayController.state.quoteStatus,this.quote=d.PayController.state.quote,this.amount=d.PayController.state.amount,this.namespace=void 0,this.caipAddress=void 0,this.profileName=null,this.activeConnectorIds=l.ConnectorController.state.activeConnectorIds,this.selectedExchange=d.PayController.state.selectedExchange,this.initializeNamespace(),this.unsubscribe.push(d.PayController.subscribeKey('quoteStatus',t=>this.quoteStatus=t),d.PayController.subscribeKey('quote',t=>this.quote=t),l.ConnectorController.subscribeKey('activeConnectorIds',t=>this.activeConnectorIds=t),d.PayController.subscribeKey('selectedExchange',t=>this.selectedExchange=t))}connectedCallback(){super.connectedCallback(),this.startPolling()}disconnectedCallback(){super.disconnectedCallback(),this.stopPolling(),this.unsubscribe.forEach(t=>t())}render(){return i.html`
      <wui-flex flexDirection="column" .padding=${['3','0','0','0']} gap="2">
        ${this.tokenTemplate()} ${this.paymentTemplate()} ${this.paymentLifecycleTemplate()}
      </wui-flex>
    `}tokenTemplate(){const t=(0,p.formatAmount)(this.amount||'0'),n=this.paymentAsset.metadata.symbol??'Unknown',s=l.ChainController.getAllRequestedCaipNetworks().find(t=>t.caipNetworkId===this.paymentAsset.network),o='failure'===this.quoteStatus||'timeout'===this.quoteStatus||'refund'===this.quoteStatus;return'success'===this.quoteStatus||'submitted'===this.quoteStatus?i.html`<wui-flex alignItems="center" justifyContent="center">
        <wui-flex justifyContent="center" alignItems="center" class="token-image success">
          <wui-icon name="checkmark" color="success" size="inherit"></wui-icon>
        </wui-flex>
      </wui-flex>`:o?i.html`<wui-flex alignItems="center" justifyContent="center">
        <wui-flex justifyContent="center" alignItems="center" class="token-image error">
          <wui-icon name="close" color="error" size="inherit"></wui-icon>
        </wui-flex>
      </wui-flex>`:i.html`
      <wui-flex alignItems="center" justifyContent="center">
        <wui-flex class="token-image-container">
          <wui-pulse size="125px" rings="3" duration="4" opacity="0.5" variant="accent-primary">
            <wui-flex justifyContent="center" alignItems="center" class="token-image loading">
              <wui-icon name="paperPlaneTitle" color="accent-primary" size="inherit"></wui-icon>
            </wui-flex>
          </wui-pulse>

          <wui-flex
            justifyContent="center"
            alignItems="center"
            class="token-badge-container loading"
          >
            <wui-flex
              alignItems="center"
              justifyContent="center"
              gap="01"
              padding="1"
              class="token-badge"
            >
              <wui-image
                src=${(0,r.ifDefined)(l.AssetUtil.getNetworkImage(s))}
                class="chain-image"
                size="mdl"
              ></wui-image>

              <wui-text variant="lg-regular" color="primary">${t} ${n}</wui-text>
            </wui-flex>
          </wui-flex>
        </wui-flex>
      </wui-flex>
    `}paymentTemplate(){return i.html`
      <wui-flex flexDirection="column" gap="2" .padding=${['0','6','0','6']}>
        ${this.renderPayment()}
        <wui-separator></wui-separator>
        ${this.renderWallet()}
      </wui-flex>
    `}paymentLifecycleTemplate(){const t=this.getStepsWithStatus();return i.html`
      <wui-flex flexDirection="column" padding="4" gap="2" class="payment-lifecycle-container">
        <wui-flex alignItems="center" justifyContent="space-between">
          <wui-text variant="md-regular" color="secondary">PAYMENT CYCLE</wui-text>

          ${this.renderPaymentCycleBadge()}
        </wui-flex>

        <wui-flex flexDirection="column" gap="5" .padding=${['2','0','2','0']}>
          ${t.map(t=>this.renderStep(t))}
        </wui-flex>
      </wui-flex>
    `}renderPaymentCycleBadge(){const t='failure'===this.quoteStatus||'timeout'===this.quoteStatus||'refund'===this.quoteStatus,n='success'===this.quoteStatus||'submitted'===this.quoteStatus;if(t)return i.html`
        <wui-flex
          justifyContent="center"
          alignItems="center"
          class="payment-step-badge error"
          gap="1"
        >
          <wui-icon name="close" color="error" size="xs"></wui-icon>
          <wui-text variant="sm-regular" color="error">Failed</wui-text>
        </wui-flex>
      `;if(n)return i.html`
        <wui-flex
          justifyContent="center"
          alignItems="center"
          class="payment-step-badge success"
          gap="1"
        >
          <wui-icon name="checkmark" color="success" size="xs"></wui-icon>
          <wui-text variant="sm-regular" color="success">Completed</wui-text>
        </wui-flex>
      `;const s=this.quote?.timeInSeconds??0;return i.html`
      <wui-flex alignItems="center" justifyContent="space-between" gap="3">
        <wui-flex
          justifyContent="center"
          alignItems="center"
          class="payment-step-badge loading"
          gap="1"
        >
          <wui-icon name="clock" color="default" size="xs"></wui-icon>
          <wui-text variant="sm-regular" color="primary">Est. ${s} sec</wui-text>
        </wui-flex>

        <wui-icon name="chevronBottom" color="default" size="xxs"></wui-icon>
      </wui-flex>
    `}renderPayment(){const t=l.ChainController.getAllRequestedCaipNetworks().find(t=>{const i=this.quote?.origin.currency.network;if(!i)return!1;const{chainId:n}=o.ParseUtil.parseCaipNetworkId(i);return c.HelpersUtil.isLowerCaseMatch(t.id.toString(),n.toString())}),n=o.NumberUtil.formatNumber(this.quote?.origin.amount||'0',{decimals:this.quote?.origin.currency.metadata.decimals??0}).toString(),s=(0,p.formatAmount)(n),u=this.quote?.origin.currency.metadata.symbol??'Unknown';return i.html`
      <wui-flex
        alignItems="flex-start"
        justifyContent="space-between"
        .padding=${['3','0','3','0']}
      >
        <wui-text variant="lg-regular" color="secondary">Payment Method</wui-text>

        <wui-flex flexDirection="column" alignItems="flex-end" gap="1">
          <wui-flex alignItems="center" gap="01">
            <wui-text variant="lg-regular" color="primary">${s}</wui-text>
            <wui-text variant="lg-regular" color="secondary">${u}</wui-text>
          </wui-flex>

          <wui-flex alignItems="center" gap="1">
            <wui-text variant="md-regular" color="secondary">on</wui-text>
            <wui-image
              src=${(0,r.ifDefined)(l.AssetUtil.getNetworkImage(t))}
              size="xs"
            ></wui-image>
            <wui-text variant="md-regular" color="secondary">${t?.name}</wui-text>
          </wui-flex>
        </wui-flex>
      </wui-flex>
    `}renderWallet(){return i.html`
      <wui-flex
        alignItems="flex-start"
        justifyContent="space-between"
        .padding=${['3','0','3','0']}
      >
        <wui-text variant="lg-regular" color="secondary"
          >${this.selectedExchange?'Exchange':'Wallet'}</wui-text
        >

        ${this.renderWalletText()}
      </wui-flex>
    `}renderWalletText(){const{image:t}=this.getWalletProperties({namespace:this.namespace}),{address:n}=this.caipAddress?o.ParseUtil.parseCaipAddress(this.caipAddress):{},s=this.selectedExchange?.name;return this.selectedExchange?i.html`
        <wui-flex alignItems="center" justifyContent="flex-end" gap="1">
          <wui-text variant="lg-regular" color="primary">${s}</wui-text>
          <wui-image src=${(0,r.ifDefined)(this.selectedExchange.imageUrl)} size="mdl"></wui-image>
        </wui-flex>
      `:i.html`
      <wui-flex alignItems="center" justifyContent="flex-end" gap="1">
        <wui-text variant="lg-regular" color="primary">
          ${u.UiHelperUtil.getTruncateString({string:this.profileName||n||s||'',charsStart:this.profileName?16:4,charsEnd:this.profileName?0:6,truncate:this.profileName?'end':'middle'})}
        </wui-text>

        <wui-image src=${(0,r.ifDefined)(t)} size="mdl"></wui-image>
      </wui-flex>
    `}getStepsWithStatus(){return'failure'===this.quoteStatus||'timeout'===this.quoteStatus||'refund'===this.quoteStatus?f.STEPS.map(t=>Object.assign({},t,{status:'failed'})):f.STEPS.map(t=>{const i=(x[t.id]??[]).includes(this.quoteStatus)?'completed':'pending';return Object.assign({},t,{status:i})})}renderStep({title:t,icon:n,status:r}){const o={'step-icon-box':!0,success:'completed'===r};return i.html`
      <wui-flex alignItems="center" gap="3">
        <wui-flex justifyContent="center" alignItems="center" class="step-icon-container">
          <wui-icon name=${n} color="default" size="mdl"></wui-icon>

          <wui-flex alignItems="center" justifyContent="center" class=${(0,s.classMap)(o)}>
            ${this.renderStatusIndicator(r)}
          </wui-flex>
        </wui-flex>

        <wui-text variant="md-regular" color="primary">${t}</wui-text>
      </wui-flex>
    `}renderStatusIndicator(t){return'completed'===t?i.html`<wui-icon size="sm" color="success" name="checkmark"></wui-icon>`:'failed'===t?i.html`<wui-icon size="sm" color="error" name="close"></wui-icon>`:'pending'===t?i.html`<wui-loading-spinner color="accent-primary" size="sm"></wui-loading-spinner>`:null}startPolling(){this.pollingInterval||(this.fetchQuoteStatus(),this.pollingInterval=setInterval(()=>{this.fetchQuoteStatus()},3e3))}stopPolling(){this.pollingInterval&&(clearInterval(this.pollingInterval),this.pollingInterval=null)}async fetchQuoteStatus(){const t=d.PayController.state.requestId;if(!t||f.TERMINAL_STATES.includes(this.quoteStatus))this.stopPolling();else try{await d.PayController.fetchQuoteStatus({requestId:t}),f.TERMINAL_STATES.includes(this.quoteStatus)&&this.stopPolling()}catch{this.stopPolling()}}initializeNamespace(){const t=l.ChainController.state.activeChain;this.namespace=t,this.caipAddress=l.ChainController.getAccountData(t)?.caipAddress,this.profileName=l.ChainController.getAccountData(t)?.profileName??null,this.unsubscribe.push(l.ChainController.subscribeChainProp('accountState',t=>{this.caipAddress=t?.caipAddress,this.profileName=t?.profileName??null},t))}getWalletProperties({namespace:t}){if(!t)return{name:void 0,image:void 0};const i=this.activeConnectorIds[t];if(!i)return{name:void 0,image:void 0};const n=l.ConnectorController.getConnector({id:i,namespace:t});if(!n)return{name:void 0,image:void 0};const s=l.AssetUtil.getConnectorImage(n);return{name:n.name,image:s}}};y.styles=h.default,w([(0,n.state)()],y.prototype,"paymentAsset",void 0),w([(0,n.state)()],y.prototype,"quoteStatus",void 0),w([(0,n.state)()],y.prototype,"quote",void 0),w([(0,n.state)()],y.prototype,"amount",void 0),w([(0,n.state)()],y.prototype,"namespace",void 0),w([(0,n.state)()],y.prototype,"caipAddress",void 0),w([(0,n.state)()],y.prototype,"profileName",void 0),w([(0,n.state)()],y.prototype,"activeConnectorIds",void 0),w([(0,n.state)()],y.prototype,"selectedExchange",void 0),e.W3mPayLoadingView=y=w([(0,u.customElement)('w3m-pay-loading-view')],y)},6224,[2,4653,4674,4723,4688,4556,4632,4650,4685,6206,4757,6225,6212,4747,4664,6215,6222,6228,6229]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0});var n=r(d[0]);Object.keys(n).forEach(function(t){"default"!==t&&"__esModule"!==t&&(t in e&&e[t]===n[t]||Object.defineProperty(e,t,{enumerable:!0,get:function(){return n[t]}}))})},6225,[6226]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.WuiPulse=void 0;var r=_r(_d[1]),i=_r(_d[2]),s=_r(_d[3]),o=_r(_d[4]),n=_r(_d[5]),p=t(_r(_d[6])),c=this&&this.__decorate||function(t,r,i,s){var o,n=arguments.length,p=n<3?r:null===s?s=Object.getOwnPropertyDescriptor(r,i):s;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)p=Reflect.decorate(t,r,i,s);else for(var c=t.length-1;c>=0;c--)(o=t[c])&&(p=(n<3?o(p):n>3?o(r,i,p):o(r,i))||p);return n>3&&p&&Object.defineProperty(r,i,p),p};const l={'accent-primary':s.vars.tokens.core.backgroundAccentPrimary};let u=e.WuiPulse=class extends r.LitElement{constructor(){super(...arguments),this.rings=3,this.duration=2,this.opacity=.3,this.size="200px",this.variant='accent-primary'}render(){const t=l[this.variant];this.style.cssText=`\n      --pulse-size: ${this.size};\n      --pulse-duration: ${this.duration}s;\n      --pulse-color: ${t};\n      --pulse-opacity: ${this.opacity};\n    `;const i=Array.from({length:this.rings},(t,r)=>this.renderRing(r,this.rings));return r.html`
      <div class="pulse-container">
        <div class="pulse-rings">${i}</div>
        <div class="pulse-content">
          <slot></slot>
        </div>
      </div>
    `}renderRing(t,i){const s=`animation-delay: ${t/i*this.duration}s;`;return r.html`<div class="pulse-ring" style=${s}></div>`}};u.styles=[o.resetStyles,p.default],c([(0,i.property)({type:Number})],u.prototype,"rings",void 0),c([(0,i.property)({type:Number})],u.prototype,"duration",void 0),c([(0,i.property)({type:Number})],u.prototype,"opacity",void 0),c([(0,i.property)()],u.prototype,"size",void 0),c([(0,i.property)()],u.prototype,"variant",void 0),e.WuiPulse=u=c([(0,n.customElement)('wui-pulse')],u)},6226,[2,4653,4674,4659,4652,4663,6227]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var t=r(d[0]);e.default=t.css`
  :host {
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .pulse-container {
    position: relative;
    width: var(--pulse-size);
    height: var(--pulse-size);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .pulse-rings {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }

  .pulse-ring {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    border: 2px solid var(--pulse-color);
    opacity: 0;
    animation: pulse var(--pulse-duration, 2s) ease-out infinite;
  }

  .pulse-content {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  @keyframes pulse {
    0% {
      transform: scale(0.5);
      opacity: var(--pulse-opacity, 0.3);
    }
    50% {
      opacity: calc(var(--pulse-opacity, 0.3) * 0.5);
    }
    100% {
      transform: scale(1.2);
      opacity: 0;
    }
  }
`},6227,[4659]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.TERMINAL_STATES=e.STEPS=void 0;e.STEPS=[{id:'received',title:'Receiving funds',icon:'dollar'},{id:'processing',title:'Swapping asset',icon:'recycleHorizontal'},{id:'sending',title:'Sending asset to the recipient address',icon:'send'}],e.TERMINAL_STATES=['success','submitted','failure','timeout','refund']},6228,[]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var o=r(d[0]);e.default=o.css`
  :host {
    display: block;
    height: 100%;
    width: 100%;
  }

  wui-image {
    border-radius: ${({borderRadius:o})=>o.round};
  }

  .token-badge-container {
    position: absolute;
    bottom: 6px;
    left: 50%;
    transform: translateX(-50%);
    border-radius: ${({borderRadius:o})=>o[4]};
    z-index: 3;
    min-width: 105px;
  }

  .token-badge-container.loading {
    background-color: ${({tokens:o})=>o.theme.backgroundPrimary};
    border: 3px solid ${({tokens:o})=>o.theme.backgroundPrimary};
  }

  .token-badge-container.success {
    background-color: ${({tokens:o})=>o.theme.backgroundPrimary};
    border: 3px solid ${({tokens:o})=>o.theme.backgroundPrimary};
  }

  .token-image-container {
    position: relative;
  }

  .token-image {
    border-radius: ${({borderRadius:o})=>o.round};
    width: 64px;
    height: 64px;
  }

  .token-image.success {
    background-color: ${({tokens:o})=>o.theme.foregroundPrimary};
  }

  .token-image.error {
    background-color: ${({tokens:o})=>o.theme.foregroundPrimary};
  }

  .token-image.loading {
    background: ${({colors:o})=>o.accent010};
  }

  .token-image wui-icon {
    width: 32px;
    height: 32px;
  }

  .token-badge {
    background-color: ${({tokens:o})=>o.theme.foregroundPrimary};
    border: 1px solid ${({tokens:o})=>o.theme.foregroundSecondary};
    border-radius: ${({borderRadius:o})=>o[4]};
  }

  .token-badge wui-text {
    white-space: nowrap;
  }

  .payment-lifecycle-container {
    background-color: ${({tokens:o})=>o.theme.foregroundPrimary};
    border-top-right-radius: ${({borderRadius:o})=>o[6]};
    border-top-left-radius: ${({borderRadius:o})=>o[6]};
  }

  .payment-step-badge {
    padding: ${({spacing:o})=>o[1]} ${({spacing:o})=>o[2]};
    border-radius: ${({borderRadius:o})=>o[1]};
  }

  .payment-step-badge.loading {
    background-color: ${({tokens:o})=>o.theme.foregroundSecondary};
  }

  .payment-step-badge.error {
    background-color: ${({tokens:o})=>o.core.backgroundError};
  }

  .payment-step-badge.success {
    background-color: ${({tokens:o})=>o.core.backgroundSuccess};
  }

  .step-icon-container {
    position: relative;
    height: 40px;
    width: 40px;
    border-radius: ${({borderRadius:o})=>o.round};
    background-color: ${({tokens:o})=>o.theme.foregroundSecondary};
  }

  .step-icon-box {
    position: absolute;
    right: -4px;
    bottom: -1px;
    padding: 2px;
    border-radius: ${({borderRadius:o})=>o.round};
    border: 2px solid ${({tokens:o})=>o.theme.backgroundPrimary};
    background-color: ${({tokens:o})=>o.theme.foregroundPrimary};
  }

  .step-icon-box.success {
    background-color: ${({tokens:o})=>o.core.backgroundSuccess};
  }
`},6229,[4650]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.W3mPayQuoteView=void 0;var s=_r(_d[1]),i=_r(_d[2]),n=_r(_d[3]),o=_r(_d[4]),r=_r(_d[5]),l=_r(_d[6]),c=_r(_d[7]);_r(_d[8]),_r(_d[9]),_r(_d[10]);var h=_r(_d[11]),u=_r(_d[12]);_r(_d[13]),_r(_d[14]),_r(_d[15]),_r(_d[16]),_r(_d[17]);var d=_r(_d[18]),p=_r(_d[19]),y=t(_r(_d[20])),f=this&&this.__decorate||function(t,s,i,n){var o,r=arguments.length,l=r<3?s:null===n?n=Object.getOwnPropertyDescriptor(s,i):n;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)l=Reflect.decorate(t,s,i,n);else for(var c=t.length-1;c>=0;c--)(o=t[c])&&(l=(r<3?o(l):r>3?o(s,i,l):o(s,i))||l);return r>3&&l&&Object.defineProperty(s,i,l),l};const w={eip155:{icon:'ethereum',label:'EVM'},solana:{icon:'solana',label:'Solana'},bip122:{icon:'bitcoin',label:'Bitcoin'},ton:{icon:'ton',label:'Ton'}};let b=e.W3mPayQuoteView=class extends s.LitElement{constructor(){super(),this.unsubscribe=[],this.profileName=null,this.paymentAsset=u.PayController.state.paymentAsset,this.namespace=void 0,this.caipAddress=void 0,this.amount=u.PayController.state.amount,this.recipient=u.PayController.state.recipient,this.activeConnectorIds=l.ConnectorController.state.activeConnectorIds,this.selectedPaymentAsset=u.PayController.state.selectedPaymentAsset,this.selectedExchange=u.PayController.state.selectedExchange,this.isFetchingQuote=u.PayController.state.isFetchingQuote,this.quoteError=u.PayController.state.quoteError,this.quote=u.PayController.state.quote,this.isFetchingTokenBalances=u.PayController.state.isFetchingTokenBalances,this.tokenBalances=u.PayController.state.tokenBalances,this.isPaymentInProgress=u.PayController.state.isPaymentInProgress,this.exchangeUrlForQuote=u.PayController.state.exchangeUrlForQuote,this.completedTransactionsCount=0,this.unsubscribe.push(u.PayController.subscribeKey('paymentAsset',t=>this.paymentAsset=t)),this.unsubscribe.push(u.PayController.subscribeKey('tokenBalances',t=>this.onTokenBalancesChanged(t))),this.unsubscribe.push(u.PayController.subscribeKey('isFetchingTokenBalances',t=>this.isFetchingTokenBalances=t)),this.unsubscribe.push(l.ConnectorController.subscribeKey('activeConnectorIds',t=>this.activeConnectorIds=t)),this.unsubscribe.push(u.PayController.subscribeKey('selectedPaymentAsset',t=>this.selectedPaymentAsset=t)),this.unsubscribe.push(u.PayController.subscribeKey('isFetchingQuote',t=>this.isFetchingQuote=t)),this.unsubscribe.push(u.PayController.subscribeKey('quoteError',t=>this.quoteError=t)),this.unsubscribe.push(u.PayController.subscribeKey('quote',t=>this.quote=t)),this.unsubscribe.push(u.PayController.subscribeKey('amount',t=>this.amount=t)),this.unsubscribe.push(u.PayController.subscribeKey('recipient',t=>this.recipient=t)),this.unsubscribe.push(u.PayController.subscribeKey('isPaymentInProgress',t=>this.isPaymentInProgress=t)),this.unsubscribe.push(u.PayController.subscribeKey('selectedExchange',t=>this.selectedExchange=t)),this.unsubscribe.push(u.PayController.subscribeKey('exchangeUrlForQuote',t=>this.exchangeUrlForQuote=t)),this.resetQuoteState(),this.initializeNamespace(),this.fetchTokens()}disconnectedCallback(){super.disconnectedCallback(),this.resetAssetsState(),this.unsubscribe.forEach(t=>t())}updated(t){super.updated(t);t.has('selectedPaymentAsset')&&this.fetchQuote()}render(){return s.html`
      <wui-flex flexDirection="column">
        ${this.profileTemplate()}

        <wui-flex
          flexDirection="column"
          gap="4"
          class="payment-methods-container"
          .padding=${['4','4','5','4']}
        >
          ${this.paymentOptionsViewTemplate()} ${this.amountWithFeeTemplate()}

          <wui-flex
            alignItems="center"
            justifyContent="space-between"
            .padding=${['1','0','1','0']}
          >
            <wui-separator></wui-separator>
          </wui-flex>

          ${this.paymentActionsTemplate()}
        </wui-flex>
      </wui-flex>
    `}profileTemplate(){if(this.selectedExchange){const t=r.NumberUtil.formatNumber(this.quote?.origin.amount,{decimals:this.quote?.origin.currency.metadata.decimals??0}).toString();return s.html`
        <wui-flex
          .padding=${['4','3','4','3']}
          alignItems="center"
          justifyContent="space-between"
          gap="2"
        >
          <wui-text variant="lg-regular" color="secondary">Paying with</wui-text>

          ${this.quote?s.html`<wui-text variant="lg-regular" color="primary">
                ${r.NumberUtil.bigNumber(t,{safe:!0}).round(6).toString()}
                ${this.quote.origin.currency.metadata.symbol}
              </wui-text>`:s.html`<wui-shimmer width="80px" height="18px" variant="light"></wui-shimmer>`}
        </wui-flex>
      `}const t=l.CoreHelperUtil.getPlainAddress(this.caipAddress)??'',{name:i,image:n}=this.getWalletProperties({namespace:this.namespace}),{icon:c,label:h}=w[this.namespace]??{};return s.html`
      <wui-flex
        .padding=${['4','3','4','3']}
        alignItems="center"
        justifyContent="space-between"
        gap="2"
      >
        <wui-wallet-switch
          profileName=${(0,o.ifDefined)(this.profileName)}
          address=${(0,o.ifDefined)(t)}
          imageSrc=${(0,o.ifDefined)(n)}
          alt=${(0,o.ifDefined)(i)}
          @click=${this.onConnectOtherWallet.bind(this)}
          data-testid="wui-wallet-switch"
        ></wui-wallet-switch>

        <wui-wallet-switch
          profileName=${(0,o.ifDefined)(h)}
          address=${(0,o.ifDefined)(t)}
          icon=${(0,o.ifDefined)(c)}
          iconSize="xs"
          .enableGreenCircle=${!1}
          alt=${(0,o.ifDefined)(h)}
          @click=${this.onConnectOtherWallet.bind(this)}
          data-testid="wui-wallet-switch"
        ></wui-wallet-switch>
      </wui-flex>
    `}initializeNamespace(){const t=l.ChainController.state.activeChain;this.namespace=t,this.caipAddress=l.ChainController.getAccountData(t)?.caipAddress,this.profileName=l.ChainController.getAccountData(t)?.profileName??null,this.unsubscribe.push(l.ChainController.subscribeChainProp('accountState',t=>this.onAccountStateChanged(t),t))}async fetchTokens(){if(this.namespace){let t;if(this.caipAddress){const{chainId:s,chainNamespace:i}=r.ParseUtil.parseCaipAddress(this.caipAddress),n=`${i}:${s}`;t=l.ChainController.getAllRequestedCaipNetworks().find(t=>t.caipNetworkId===n)}await u.PayController.fetchTokens({caipAddress:this.caipAddress,caipNetwork:t,namespace:this.namespace})}}fetchQuote(){if(this.amount&&this.recipient&&this.selectedPaymentAsset&&this.paymentAsset){const{address:t}=this.caipAddress?r.ParseUtil.parseCaipAddress(this.caipAddress):{};u.PayController.fetchQuote({amount:this.amount.toString(),address:t,sourceToken:this.selectedPaymentAsset,toToken:this.paymentAsset,recipient:this.recipient})}}getWalletProperties({namespace:t}){if(!t)return{name:void 0,image:void 0};const s=this.activeConnectorIds[t];if(!s)return{name:void 0,image:void 0};const i=l.ConnectorController.getConnector({id:s,namespace:t});if(!i)return{name:void 0,image:void 0};const n=l.AssetUtil.getConnectorImage(i);return{name:i.name,image:n}}paymentOptionsViewTemplate(){return s.html`
      <wui-flex flexDirection="column" gap="2">
        <wui-text variant="sm-regular" color="secondary">CHOOSE PAYMENT OPTION</wui-text>
        <wui-flex class="pay-options-container">${this.paymentOptionsTemplate()}</wui-flex>
      </wui-flex>
    `}paymentOptionsTemplate(){const t=this.getPaymentAssetFromTokenBalances();if(this.isFetchingTokenBalances)return s.html`<w3m-pay-options-skeleton></w3m-pay-options-skeleton>`;if(0===t.length)return s.html`<w3m-pay-options-empty
        @connectOtherWallet=${this.onConnectOtherWallet.bind(this)}
      ></w3m-pay-options-empty>`;const i={disabled:this.isFetchingQuote};return s.html`<w3m-pay-options
      class=${(0,n.classMap)(i)}
      .options=${t}
      .selectedPaymentAsset=${(0,o.ifDefined)(this.selectedPaymentAsset)}
      .onSelect=${this.onSelectedPaymentAssetChanged.bind(this)}
    ></w3m-pay-options>`}amountWithFeeTemplate(){return this.isFetchingQuote||!this.selectedPaymentAsset||this.quoteError?s.html`<w3m-pay-fees-skeleton></w3m-pay-fees-skeleton>`:s.html`<w3m-pay-fees></w3m-pay-fees>`}paymentActionsTemplate(){const t=this.isFetchingQuote||this.isFetchingTokenBalances,i=this.isFetchingQuote||this.isFetchingTokenBalances||!this.selectedPaymentAsset||Boolean(this.quoteError),n=r.NumberUtil.formatNumber(this.quote?.origin.amount??0,{decimals:this.quote?.origin.currency.metadata.decimals??0}).toString();return this.selectedExchange?t||i?s.html`
          <wui-shimmer width="100%" height="48px" variant="light" ?rounded=${!0}></wui-shimmer>
        `:s.html`<wui-button
        size="lg"
        fullWidth
        variant="accent-secondary"
        @click=${this.onPayWithExchange.bind(this)}
      >
        ${`Continue in ${this.selectedExchange.name}`}

        <wui-icon name="arrowRight" color="inherit" size="sm" slot="iconRight"></wui-icon>
      </wui-button>`:s.html`
      <wui-flex alignItems="center" justifyContent="space-between">
        <wui-flex flexDirection="column" gap="1">
          <wui-text variant="md-regular" color="secondary">Order Total</wui-text>

          ${t||i?s.html`<wui-shimmer width="58px" height="32px" variant="light"></wui-shimmer>`:s.html`<wui-flex alignItems="center" gap="01">
                <wui-text variant="h4-regular" color="primary">${(0,d.formatAmount)(n)}</wui-text>

                <wui-text variant="lg-regular" color="secondary">
                  ${this.quote?.origin.currency.metadata.symbol||'Unknown'}
                </wui-text>
              </wui-flex>`}
        </wui-flex>

        ${this.actionButtonTemplate({isLoading:t,isDisabled:i})}
      </wui-flex>
    `}actionButtonTemplate(t){const i=(0,p.getTransactionsSteps)(this.quote),{isLoading:n,isDisabled:o}=t;let r='Pay';return i.length>1&&0===this.completedTransactionsCount&&(r='Approve'),s.html`
      <wui-button
        size="lg"
        variant="accent-primary"
        ?loading=${n||this.isPaymentInProgress}
        ?disabled=${o||this.isPaymentInProgress}
        @click=${()=>{i.length>0?this.onSendTransactions():this.onTransfer()}}
      >
        ${r}
        ${n?null:s.html`<wui-icon
              name="arrowRight"
              color="inherit"
              size="sm"
              slot="iconRight"
            ></wui-icon>`}
      </wui-button>
    `}getPaymentAssetFromTokenBalances(){if(!this.namespace)return[];return(this.tokenBalances[this.namespace]??[]).map(t=>{try{return(0,d.formatBalanceToPaymentAsset)(t)}catch(t){return null}}).filter(t=>Boolean(t)).filter(t=>{const{chainId:s}=r.ParseUtil.parseCaipNetworkId(t.network),{chainId:i}=r.ParseUtil.parseCaipNetworkId(this.paymentAsset.network);return!!h.HelpersUtil.isLowerCaseMatch(t.asset,this.paymentAsset.asset)||(!this.selectedExchange||!h.HelpersUtil.isLowerCaseMatch(s.toString(),i.toString()))})}onTokenBalancesChanged(t){this.tokenBalances=t;const[s]=this.getPaymentAssetFromTokenBalances();s&&u.PayController.setSelectedPaymentAsset(s)}async onConnectOtherWallet(){await l.ConnectorController.connect(),await l.ModalController.open({view:'PayQuote'})}onAccountStateChanged(t){const{address:s}=this.caipAddress?r.ParseUtil.parseCaipAddress(this.caipAddress):{};if(this.caipAddress=t?.caipAddress,this.profileName=t?.profileName??null,s){const{address:t}=this.caipAddress?r.ParseUtil.parseCaipAddress(this.caipAddress):{};t?h.HelpersUtil.isLowerCaseMatch(t,s)||(this.resetAssetsState(),this.resetQuoteState(),this.fetchTokens()):l.ModalController.close()}}onSelectedPaymentAssetChanged(t){this.isFetchingQuote||u.PayController.setSelectedPaymentAsset(t)}async onTransfer(){const t=(0,p.getTransferStep)(this.quote);if(t){if(!h.HelpersUtil.isLowerCaseMatch(this.selectedPaymentAsset?.asset,t.deposit.currency))throw new Error('Quote asset is not the same as the selected payment asset');const s=this.selectedPaymentAsset?.amount??'0',i=r.NumberUtil.formatNumber(t.deposit.amount,{decimals:this.selectedPaymentAsset?.metadata.decimals??0}).toString();if(!r.NumberUtil.bigNumber(s).gte(i))return void l.SnackController.showError('Insufficient funds');if(this.quote&&this.selectedPaymentAsset&&this.caipAddress&&this.namespace){const{address:s}=r.ParseUtil.parseCaipAddress(this.caipAddress);await u.PayController.onTransfer({chainNamespace:this.namespace,fromAddress:s,toAddress:t.deposit.receiver,amount:i,paymentAsset:this.selectedPaymentAsset}),u.PayController.setRequestId(t.requestId),l.RouterController.push('PayLoading')}}}async onSendTransactions(){const t=this.selectedPaymentAsset?.amount??'0',s=r.NumberUtil.formatNumber(this.quote?.origin.amount??0,{decimals:this.selectedPaymentAsset?.metadata.decimals??0}).toString();if(!r.NumberUtil.bigNumber(t).gte(s))return void l.SnackController.showError('Insufficient funds');const i=(0,p.getTransactionsSteps)(this.quote),[n]=(0,p.getTransactionsSteps)(this.quote,this.completedTransactionsCount);if(n&&this.namespace){await u.PayController.onSendTransaction({namespace:this.namespace,transactionStep:n}),this.completedTransactionsCount+=1;this.completedTransactionsCount===i.length&&(u.PayController.setRequestId(n.requestId),l.RouterController.push('PayLoading'))}}onPayWithExchange(){if(this.exchangeUrlForQuote){const t=l.CoreHelperUtil.returnOpenHref('','popupWindow','scrollbar=yes,width=480,height=720');if(!t)throw new Error('Could not create popup window');t.location.href=this.exchangeUrlForQuote;const s=(0,p.getTransferStep)(this.quote);s&&u.PayController.setRequestId(s.requestId),u.PayController.initiatePayment(),l.RouterController.push('PayLoading')}}resetAssetsState(){u.PayController.setSelectedPaymentAsset(null)}resetQuoteState(){u.PayController.resetQuoteState()}};b.styles=y.default,f([(0,i.state)()],b.prototype,"profileName",void 0),f([(0,i.state)()],b.prototype,"paymentAsset",void 0),f([(0,i.state)()],b.prototype,"namespace",void 0),f([(0,i.state)()],b.prototype,"caipAddress",void 0),f([(0,i.state)()],b.prototype,"amount",void 0),f([(0,i.state)()],b.prototype,"recipient",void 0),f([(0,i.state)()],b.prototype,"activeConnectorIds",void 0),f([(0,i.state)()],b.prototype,"selectedPaymentAsset",void 0),f([(0,i.state)()],b.prototype,"selectedExchange",void 0),f([(0,i.state)()],b.prototype,"isFetchingQuote",void 0),f([(0,i.state)()],b.prototype,"quoteError",void 0),f([(0,i.state)()],b.prototype,"quote",void 0),f([(0,i.state)()],b.prototype,"isFetchingTokenBalances",void 0),f([(0,i.state)()],b.prototype,"tokenBalances",void 0),f([(0,i.state)()],b.prototype,"isPaymentInProgress",void 0),f([(0,i.state)()],b.prototype,"exchangeUrlForQuote",void 0),f([(0,i.state)()],b.prototype,"completedTransactionsCount",void 0),e.W3mPayQuoteView=b=f([(0,c.customElement)('w3m-pay-quote-view')],b)},6230,[2,4653,4674,4723,4688,4556,4632,4650,4685,4747,6231,4664,6215,6234,6236,6238,6240,6242,6222,6221,6244]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0});var n=r(d[0]);Object.keys(n).forEach(function(t){"default"!==t&&"__esModule"!==t&&(t in e&&e[t]===n[t]||Object.defineProperty(e,t,{enumerable:!0,get:function(){return n[t]}}))})},6231,[6232]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.WuiWalletSwitch=void 0;var i=_r(_d[1]),r=_r(_d[2]),o=_r(_d[3]);_r(_d[4]),_r(_d[5]),_r(_d[6]),_r(_d[7]);var l=_r(_d[8]),s=_r(_d[9]),n=_r(_d[10]),c=t(_r(_d[11])),p=this&&this.__decorate||function(t,i,r,o){var l,s=arguments.length,n=s<3?i:null===o?o=Object.getOwnPropertyDescriptor(i,r):o;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)n=Reflect.decorate(t,i,r,o);else for(var c=t.length-1;c>=0;c--)(l=t[c])&&(n=(s<3?l(n):s>3?l(i,r,n):l(i,r))||n);return s>3&&n&&Object.defineProperty(i,r,n),n};let h=e.WuiWalletSwitch=class extends i.LitElement{constructor(){super(...arguments),this.address='',this.profileName='',this.alt='',this.imageSrc='',this.icon=void 0,this.iconSize='md',this.enableGreenCircle=!0,this.loading=!1,this.charsStart=4,this.charsEnd=6}render(){return i.html`
      <button>
        ${this.leftImageTemplate()} ${this.textTemplate()} ${this.rightImageTemplate()}
      </button>
    `}leftImageTemplate(){const t=this.icon?i.html`<wui-icon
          size=${(0,o.ifDefined)(this.iconSize)}
          color="default"
          name=${this.icon}
          class="icon"
        ></wui-icon>`:i.html`<wui-image src=${this.imageSrc} alt=${this.alt}></wui-image>`;return i.html`
      <wui-flex
        alignItems="center"
        justifyContent="center"
        class="icon-box"
        data-active=${Boolean(this.icon)}
      >
        ${t}
        ${this.enableGreenCircle?i.html`<wui-flex class="circle"></wui-flex>`:null}
      </wui-flex>
    `}textTemplate(){return i.html`
      <wui-text variant="lg-regular" color="primary">
        ${s.UiHelperUtil.getTruncateString({string:this.profileName||this.address,charsStart:this.profileName?16:this.charsStart,charsEnd:this.profileName?0:this.charsEnd,truncate:this.profileName?'end':'middle'})}
      </wui-text>
    `}rightImageTemplate(){return i.html`<wui-icon name="chevronBottom" size="sm" color="default"></wui-icon>`}};h.styles=[l.resetStyles,l.elementStyles,c.default],p([(0,r.property)()],h.prototype,"address",void 0),p([(0,r.property)()],h.prototype,"profileName",void 0),p([(0,r.property)()],h.prototype,"alt",void 0),p([(0,r.property)()],h.prototype,"imageSrc",void 0),p([(0,r.property)()],h.prototype,"icon",void 0),p([(0,r.property)()],h.prototype,"iconSize",void 0),p([(0,r.property)({type:Boolean})],h.prototype,"enableGreenCircle",void 0),p([(0,r.property)({type:Boolean})],h.prototype,"loading",void 0),p([(0,r.property)({type:Number})],h.prototype,"charsStart",void 0),p([(0,r.property)({type:Number})],h.prototype,"charsEnd",void 0),e.WuiWalletSwitch=h=p([(0,n.customElement)('wui-wallet-switch')],h)},6232,[2,4653,4674,4688,4692,4731,4722,4686,4652,4661,4663,6233]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var o=r(d[0]);e.default=o.css`
  button {
    display: flex;
    align-items: center;
    height: 40px;
    padding: ${({spacing:o})=>o[2]};
    border-radius: ${({borderRadius:o})=>o[4]};
    column-gap: ${({spacing:o})=>o[1]};
    background-color: transparent;
    transition: background-color ${({durations:o})=>o.lg}
      ${({easings:o})=>o['ease-out-power-2']};
    will-change: background-color;
  }

  wui-image,
  .icon-box {
    width: ${({spacing:o})=>o[6]};
    height: ${({spacing:o})=>o[6]};
    border-radius: ${({borderRadius:o})=>o[4]};
  }

  wui-text {
    flex: 1;
  }

  .icon-box {
    position: relative;
  }

  .icon-box[data-active='true'] {
    background-color: ${({tokens:o})=>o.theme.foregroundSecondary};
  }

  .circle {
    position: absolute;
    left: 16px;
    top: 15px;
    width: 8px;
    height: 8px;
    background-color: ${({tokens:o})=>o.core.textSuccess};
    box-shadow: 0 0 0 2px ${({tokens:o})=>o.theme.foregroundPrimary};
    border-radius: 50%;
  }

  /* -- Hover & Active states ----------------------------------------------------------- */
  @media (hover: hover) {
    button:hover:enabled,
    button:active:enabled {
      background-color: ${({tokens:o})=>o.theme.foregroundPrimary};
    }
  }
`},6233,[4659]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.W3mPayFeesSkeleton=void 0;var i=_r(_d[1]),r=_r(_d[2]);_r(_d[3]),_r(_d[4]),_r(_d[5]);var n=t(_r(_d[6])),l=this&&this.__decorate||function(t,i,r,n){var l,u=arguments.length,s=u<3?i:null===n?n=Object.getOwnPropertyDescriptor(i,r):n;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)s=Reflect.decorate(t,i,r,n);else for(var o=t.length-1;o>=0;o--)(l=t[o])&&(s=(u<3?l(s):u>3?l(i,r,s):l(i,r))||s);return u>3&&s&&Object.defineProperty(i,r,s),s};let u=e.W3mPayFeesSkeleton=class extends i.LitElement{render(){return i.html`
      <wui-flex flexDirection="column" gap="4">
        <wui-flex alignItems="center" justifyContent="space-between">
          <wui-text variant="md-regular" color="secondary">Pay</wui-text>
          <wui-shimmer width="60px" height="16px" borderRadius="4xs" variant="light"></wui-shimmer>
        </wui-flex>

        <wui-flex alignItems="center" justifyContent="space-between">
          <wui-text variant="md-regular" color="secondary">Network Fee</wui-text>

          <wui-flex flexDirection="column" alignItems="flex-end" gap="2">
            <wui-shimmer
              width="75px"
              height="16px"
              borderRadius="4xs"
              variant="light"
            ></wui-shimmer>

            <wui-flex alignItems="center" gap="01">
              <wui-shimmer width="14px" height="14px" rounded variant="light"></wui-shimmer>
              <wui-shimmer
                width="49px"
                height="14px"
                borderRadius="4xs"
                variant="light"
              ></wui-shimmer>
            </wui-flex>
          </wui-flex>
        </wui-flex>

        <wui-flex alignItems="center" justifyContent="space-between">
          <wui-text variant="md-regular" color="secondary">Service Fee</wui-text>
          <wui-shimmer width="75px" height="16px" borderRadius="4xs" variant="light"></wui-shimmer>
        </wui-flex>
      </wui-flex>
    `}};u.styles=[n.default],e.W3mPayFeesSkeleton=u=l([(0,r.customElement)('w3m-pay-fees-skeleton')],u)},6234,[2,4653,4650,4685,4749,4747,6235]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var l=r(d[0]);e.default=l.css`
  :host {
    display: block;
  }
`},6235,[4653]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.W3mPayFees=void 0;var r=_r(_d[1]),i=_r(_d[2]),n=_r(_d[3]),o=_r(_d[4]),u=_r(_d[5]),l=_r(_d[6]);_r(_d[7]),_r(_d[8]),_r(_d[9]);var s=_r(_d[10]),c=_r(_d[11]),d=t(_r(_d[12])),w=this&&this.__decorate||function(t,r,i,n){var o,u=arguments.length,l=u<3?r:null===n?n=Object.getOwnPropertyDescriptor(r,i):n;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)l=Reflect.decorate(t,r,i,n);else for(var s=t.length-1;s>=0;s--)(o=t[s])&&(l=(u<3?o(l):u>3?o(r,i,l):o(r,i))||l);return u>3&&l&&Object.defineProperty(r,i,l),l};let f=e.W3mPayFees=class extends r.LitElement{constructor(){super(),this.unsubscribe=[],this.quote=c.PayController.state.quote,this.unsubscribe.push(c.PayController.subscribeKey('quote',t=>this.quote=t))}disconnectedCallback(){this.unsubscribe.forEach(t=>t())}render(){const t=o.NumberUtil.formatNumber(this.quote?.origin.amount||'0',{decimals:this.quote?.origin.currency.metadata.decimals??0,round:6}).toString();return r.html`
      <wui-flex flexDirection="column" gap="4">
        <wui-flex alignItems="center" justifyContent="space-between">
          <wui-text variant="md-regular" color="secondary">Pay</wui-text>
          <wui-text variant="md-regular" color="primary">
            ${t} ${this.quote?.origin.currency.metadata.symbol||'Unknown'}
          </wui-text>
        </wui-flex>

        ${this.quote&&this.quote.fees.length>0?this.quote.fees.map(t=>this.renderFee(t)):null}
      </wui-flex>
    `}renderFee(t){const i='network'===t.id,l=o.NumberUtil.formatNumber(t.amount||'0',{decimals:t.currency.metadata.decimals??0,round:6}).toString();if(i){const i=u.ChainController.getAllRequestedCaipNetworks().find(r=>s.HelpersUtil.isLowerCaseMatch(r.caipNetworkId,t.currency.network));return r.html`
        <wui-flex alignItems="center" justifyContent="space-between">
          <wui-text variant="md-regular" color="secondary">${t.label}</wui-text>

          <wui-flex flexDirection="column" alignItems="flex-end" gap="2">
            <wui-text variant="md-regular" color="primary">
              ${l} ${t.currency.metadata.symbol||'Unknown'}
            </wui-text>

            <wui-flex alignItems="center" gap="01">
              <wui-image
                src=${(0,n.ifDefined)(u.AssetUtil.getNetworkImage(i))}
                size="xs"
              ></wui-image>
              <wui-text variant="sm-regular" color="secondary">
                ${i?.name||'Unknown'}
              </wui-text>
            </wui-flex>
          </wui-flex>
        </wui-flex>
      `}return r.html`
      <wui-flex alignItems="center" justifyContent="space-between">
        <wui-text variant="md-regular" color="secondary">${t.label}</wui-text>
        <wui-text variant="md-regular" color="primary">
          ${l} ${t.currency.metadata.symbol||'Unknown'}
        </wui-text>
      </wui-flex>
    `}};f.styles=[d.default],w([(0,i.state)()],f.prototype,"quote",void 0),e.W3mPayFees=f=w([(0,l.customElement)('w3m-pay-fees')],f)},6236,[2,4653,4674,4688,4556,4632,4650,4685,6206,4747,4664,6215,6237]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var o=r(d[0]);e.default=o.css`
  :host {
    display: block;
  }

  wui-image {
    border-radius: ${({borderRadius:o})=>o.round};
  }
`},6237,[4650]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.W3mPayOptionsEmpty=void 0;var n=_r(_d[1]),c=_r(_d[2]),o=_r(_d[3]);_r(_d[4]),_r(_d[5]),_r(_d[6]),_r(_d[7]);var i=_r(_d[8]),s=t(_r(_d[9])),r=this&&this.__decorate||function(t,n,c,o){var i,s=arguments.length,r=s<3?n:null===o?o=Object.getOwnPropertyDescriptor(n,c):o;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)r=Reflect.decorate(t,n,c,o);else for(var l=t.length-1;l>=0;l--)(i=t[l])&&(r=(s<3?i(r):s>3?i(n,c,r):i(n,c))||r);return s>3&&r&&Object.defineProperty(n,c,r),r};let l=e.W3mPayOptionsEmpty=class extends n.LitElement{constructor(){super(),this.unsubscribe=[],this.selectedExchange=i.PayController.state.selectedExchange,this.unsubscribe.push(i.PayController.subscribeKey('selectedExchange',t=>this.selectedExchange=t))}disconnectedCallback(){this.unsubscribe.forEach(t=>t())}render(){const t=Boolean(this.selectedExchange);return n.html`
      <wui-flex
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
        gap="3"
        class="disabled-container"
      >
        <wui-icon name="coins" color="default" size="inherit"></wui-icon>

        <wui-text variant="md-regular" color="primary" align="center">
          You don't have enough funds to complete this transaction
        </wui-text>

        ${t?null:n.html`<wui-button
              size="md"
              variant="neutral-secondary"
              @click=${this.dispatchConnectOtherWalletEvent.bind(this)}
              >Connect other wallet</wui-button
            >`}
      </wui-flex>
    `}dispatchConnectOtherWalletEvent(){this.dispatchEvent(new CustomEvent('connectOtherWallet',{detail:!0,bubbles:!0,composed:!0}))}};l.styles=[s.default],r([(0,c.property)({type:Array})],l.prototype,"selectedExchange",void 0),e.W3mPayOptionsEmpty=l=r([(0,o.customElement)('w3m-pay-options-empty')],l)},6238,[2,4653,4674,4650,4738,4685,4743,4747,6215,6239]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var t=r(d[0]);e.default=t.css`
  :host {
    display: block;
    width: 100%;
  }

  .disabled-container {
    padding: ${({spacing:t})=>t[2]};
    min-height: 168px;
  }

  wui-icon {
    width: ${({spacing:t})=>t[8]};
    height: ${({spacing:t})=>t[8]};
  }

  wui-flex > wui-text {
    max-width: 273px;
  }
`},6239,[4650]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.W3mPayOptionsSkeleton=void 0;var i=_r(_d[1]),n=_r(_d[2]);_r(_d[3]),_r(_d[4]);var r=t(_r(_d[5])),o=this&&this.__decorate||function(t,i,n,r){var o,l=arguments.length,s=l<3?i:null===r?r=Object.getOwnPropertyDescriptor(i,n):r;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)s=Reflect.decorate(t,i,n,r);else for(var u=t.length-1;u>=0;u--)(o=t[u])&&(s=(l<3?o(s):l>3?o(i,n,s):o(i,n))||s);return l>3&&s&&Object.defineProperty(i,n,s),s};let l=e.W3mPayOptionsSkeleton=class extends i.LitElement{render(){return i.html`
      <wui-flex flexDirection="column" gap="2" class="pay-options-container">
        ${this.renderOptionEntry()} ${this.renderOptionEntry()} ${this.renderOptionEntry()}
      </wui-flex>
    `}renderOptionEntry(){return i.html`
      <wui-flex
        alignItems="center"
        justifyContent="space-between"
        gap="2"
        class="pay-option-container"
      >
        <wui-flex alignItems="center" gap="2">
          <wui-flex class="token-images-container">
            <wui-shimmer
              width="32px"
              height="32px"
              rounded
              variant="light"
              class="token-image"
            ></wui-shimmer>
            <wui-shimmer
              width="16px"
              height="16px"
              rounded
              variant="light"
              class="chain-image"
            ></wui-shimmer>
          </wui-flex>

          <wui-flex flexDirection="column" gap="1">
            <wui-shimmer
              width="74px"
              height="16px"
              borderRadius="4xs"
              variant="light"
            ></wui-shimmer>
            <wui-shimmer
              width="46px"
              height="14px"
              borderRadius="4xs"
              variant="light"
            ></wui-shimmer>
          </wui-flex>
        </wui-flex>
      </wui-flex>
    `}};l.styles=[r.default],e.W3mPayOptionsSkeleton=l=o([(0,n.customElement)('w3m-pay-options-skeleton')],l)},6240,[2,4653,4650,4685,4749,6241]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var o=r(d[0]);e.default=o.css`
  :host {
    display: block;
    width: 100%;
  }

  .pay-options-container {
    max-height: 196px;
    overflow-y: auto;
    overflow-x: hidden;
    scrollbar-width: none;
  }

  .pay-options-container::-webkit-scrollbar {
    display: none;
  }

  .pay-option-container {
    border-radius: ${({borderRadius:o})=>o[4]};
    padding: ${({spacing:o})=>o[3]};
    min-height: 60px;
  }

  .token-images-container {
    position: relative;
    justify-content: center;
    align-items: center;
  }

  .chain-image {
    position: absolute;
    bottom: -3px;
    right: -5px;
    border: 2px solid ${({tokens:o})=>o.theme.foregroundSecondary};
  }
`},6241,[4650]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.W3mPayOptions=void 0;var o=_r(_d[1]),i=_r(_d[2]),s=_r(_d[3]),r=_r(_d[4]),n=_r(_d[5]),l=_r(_d[6]);_r(_d[7]),_r(_d[8]);var c=t(_r(_d[9])),p=this&&this.__decorate||function(t,o,i,s){var r,n=arguments.length,l=n<3?o:null===s?s=Object.getOwnPropertyDescriptor(o,i):s;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)l=Reflect.decorate(t,o,i,s);else for(var c=t.length-1;c>=0;c--)(r=t[c])&&(l=(n<3?r(l):n>3?r(o,i,l):r(o,i))||l);return n>3&&l&&Object.defineProperty(o,i,l),l};let y=e.W3mPayOptions=class extends o.LitElement{constructor(){super(),this.unsubscribe=[],this.options=[],this.selectedPaymentAsset=null}disconnectedCallback(){this.unsubscribe.forEach(t=>t()),this.resizeObserver?.disconnect();const t=this.shadowRoot?.querySelector('.pay-options-container');t?.removeEventListener('scroll',this.handleOptionsListScroll.bind(this))}firstUpdated(){const t=this.shadowRoot?.querySelector('.pay-options-container');t&&(requestAnimationFrame(this.handleOptionsListScroll.bind(this)),t?.addEventListener('scroll',this.handleOptionsListScroll.bind(this)),this.resizeObserver=new ResizeObserver(()=>{this.handleOptionsListScroll()}),this.resizeObserver?.observe(t),this.handleOptionsListScroll())}render(){return o.html`
      <wui-flex flexDirection="column" gap="2" class="pay-options-container">
        ${this.options.map(t=>this.payOptionTemplate(t))}
      </wui-flex>
    `}payOptionTemplate(t){const{network:i,metadata:l,asset:c,amount:p="0"}=t,y=n.ChainController.getAllRequestedCaipNetworks().find(t=>t.caipNetworkId===i),u=`${i}:${c}`===`${this.selectedPaymentAsset?.network}:${this.selectedPaymentAsset?.asset}`,h=r.NumberUtil.bigNumber(p,{safe:!0}),d=h.gt(0);return o.html`
      <wui-flex
        alignItems="center"
        justifyContent="space-between"
        gap="2"
        @click=${()=>this.onSelect?.(t)}
        class="pay-option-container"
      >
        <wui-flex alignItems="center" gap="2">
          <wui-flex class="token-images-container">
            <wui-image
              src=${(0,s.ifDefined)(l.logoURI)}
              class="token-image"
              size="3xl"
            ></wui-image>
            <wui-image
              src=${(0,s.ifDefined)(n.AssetUtil.getNetworkImage(y))}
              class="chain-image"
              size="md"
            ></wui-image>
          </wui-flex>

          <wui-flex flexDirection="column" gap="1">
            <wui-text variant="lg-regular" color="primary">${l.symbol}</wui-text>
            ${d?o.html`<wui-text variant="sm-regular" color="secondary">
                  ${h.round(6).toString()} ${l.symbol}
                </wui-text>`:null}
          </wui-flex>
        </wui-flex>

        ${u?o.html`<wui-icon name="checkmark" size="md" color="success"></wui-icon>`:null}
      </wui-flex>
    `}handleOptionsListScroll(){const t=this.shadowRoot?.querySelector('.pay-options-container');if(!t)return;t.scrollHeight>300?(t.style.setProperty('--options-mask-image',"linear-gradient(\n          to bottom,\n          rgba(0, 0, 0, calc(1 - var(--options-scroll--top-opacity))) 0px,\n          rgba(200, 200, 200, calc(1 - var(--options-scroll--top-opacity))) 1px,\n          black 50px,\n          black calc(100% - 50px),\n          rgba(155, 155, 155, calc(1 - var(--options-scroll--bottom-opacity))) calc(100% - 1px),\n          rgba(0, 0, 0, calc(1 - var(--options-scroll--bottom-opacity))) 100%\n        )"),t.style.setProperty('--options-scroll--top-opacity',l.MathUtil.interpolate([0,50],[0,1],t.scrollTop).toString()),t.style.setProperty('--options-scroll--bottom-opacity',l.MathUtil.interpolate([0,50],[0,1],t.scrollHeight-t.scrollTop-t.offsetHeight).toString())):(t.style.setProperty('--options-mask-image','none'),t.style.setProperty('--options-scroll--top-opacity','0'),t.style.setProperty('--options-scroll--bottom-opacity','0'))}};y.styles=[c.default],p([(0,i.property)({type:Array})],y.prototype,"options",void 0),p([(0,i.property)()],y.prototype,"selectedPaymentAsset",void 0),p([(0,i.property)()],y.prototype,"onSelect",void 0),e.W3mPayOptions=y=p([(0,l.customElement)('w3m-pay-options')],y)},6242,[2,4653,4674,4688,4556,4632,4650,4685,4747,6243]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var o=r(d[0]);e.default=o.css`
  :host {
    display: block;
    width: 100%;
  }

  .pay-options-container {
    max-height: 196px;
    overflow-y: auto;
    overflow-x: hidden;
    scrollbar-width: none;
    mask-image: var(--options-mask-image);
    -webkit-mask-image: var(--options-mask-image);
  }

  .pay-options-container::-webkit-scrollbar {
    display: none;
  }

  .pay-option-container {
    cursor: pointer;
    border-radius: ${({borderRadius:o})=>o[4]};
    padding: ${({spacing:o})=>o[3]};
    transition: background-color ${({durations:o})=>o.lg}
      ${({easings:o})=>o['ease-out-power-1']};
    will-change: background-color;
  }

  .token-images-container {
    position: relative;
    justify-content: center;
    align-items: center;
  }

  .token-image {
    border-radius: ${({borderRadius:o})=>o.round};
    width: 32px;
    height: 32px;
  }

  .chain-image {
    position: absolute;
    width: 16px;
    height: 16px;
    bottom: -3px;
    right: -5px;
    border-radius: ${({borderRadius:o})=>o.round};
    border: 2px solid ${({tokens:o})=>o.theme.backgroundPrimary};
  }

  @media (hover: hover) and (pointer: fine) {
    .pay-option-container:hover {
      background-color: ${({tokens:o})=>o.theme.foregroundPrimary};
    }
  }
`},6243,[4650]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var o=r(d[0]);e.default=o.css`
  .payment-methods-container {
    background-color: ${({tokens:o})=>o.theme.foregroundPrimary};
    border-top-right-radius: ${({borderRadius:o})=>o[5]};
    border-top-left-radius: ${({borderRadius:o})=>o[5]};
  }

  .pay-options-container {
    background-color: ${({tokens:o})=>o.theme.foregroundSecondary};
    border-radius: ${({borderRadius:o})=>o[5]};
    padding: ${({spacing:o})=>o[1]};
  }

  w3m-tooltip-trigger {
    display: flex;
    align-items: center;
    justify-content: center;
    max-width: fit-content;
  }

  wui-image {
    border-radius: ${({borderRadius:o})=>o.round};
  }

  w3m-pay-options.disabled {
    opacity: 0.5;
    pointer-events: none;
  }
`},6244,[4650]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.getAvailableExchanges=function(n){return t.PayController.getAvailableExchanges(n)},e.getExchanges=function(){return t.PayController.getExchanges()},e.getIsPaymentInProgress=function(){return t.PayController.state.isPaymentInProgress},e.getPayError=function(){return t.PayController.state.error},e.getPayResult=function(){return t.PayController.state.currentPayment?.result},e.getPayUrl=function(n,o){return t.PayController.getPayUrl(n,o,!0)},e.openPay=s,e.openPayUrl=function(n,o,s){return t.PayController.openPayUrl({exchangeId:n,openInNewTab:s},o,!0)},e.pay=async function(P,c=o){if(c<=0)throw new n.AppKitPayError(n.AppKitPayErrorCodes.INVALID_PAYMENT_CONFIG,'Timeout must be greater than 0');try{await s(P)}catch(t){if(t instanceof n.AppKitPayError)throw t;throw new n.AppKitPayError(n.AppKitPayErrorCodes.UNABLE_TO_INITIATE_PAYMENT,t.message)}return new Promise((o,s)=>{let P=!1;const l=setTimeout(()=>{P||(P=!0,C(),s(new n.AppKitPayError(n.AppKitPayErrorCodes.GENERIC_PAYMENT_ERROR,'Payment timeout')))},c);function y(){if(P)return;const n=t.PayController.state.currentPayment,s=t.PayController.state.error,u=t.PayController.state.isPaymentInProgress;return'SUCCESS'===n?.status?(P=!0,C(),clearTimeout(l),void o({success:!0,result:n.result})):'FAILED'===n?.status?(P=!0,C(),clearTimeout(l),void o({success:!1,error:s||'Payment failed'})):void(!s||u||n||(P=!0,C(),clearTimeout(l),o({success:!1,error:s})))}const E=u('currentPayment',y),p=u('error',y),f=u('isPaymentInProgress',y),C=(A=[E,p,f],()=>{A.forEach(t=>{try{t()}catch{}})});var A;y()})},e.subscribeStateKey=u;var t=r(d[0]),n=r(d[1]);const o=3e5;async function s(n){return t.PayController.handleOpenPay(n)}function u(n,o){return t.PayController.subscribeKey(n,o)}},6245,[6215,6218]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.solanaUSDT=e.solanaUSDC=e.solanaSOL=e.polygonUSDT=e.polygonUSDC=e.optimismUSDT=e.optimismUSDC=e.ethereumUSDT=e.ethereumUSDC=e.baseUSDC=e.baseSepoliaETH=e.baseETH=e.arbitrumUSDT=e.arbitrumUSDC=void 0;e.baseETH={network:'eip155:8453',asset:'native',metadata:{name:'Ethereum',symbol:'ETH',decimals:18}},e.baseUSDC={network:'eip155:8453',asset:'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',metadata:{name:'USD Coin',symbol:'USDC',decimals:6}},e.baseSepoliaETH={network:'eip155:84532',asset:'native',metadata:{name:'Ethereum',symbol:'ETH',decimals:18}},e.ethereumUSDC={network:'eip155:1',asset:'0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',metadata:{name:'USD Coin',symbol:'USDC',decimals:6}},e.optimismUSDC={network:'eip155:10',asset:'0x0b2c639c533813f4aa9d7837caf62653d097ff85',metadata:{name:'USD Coin',symbol:'USDC',decimals:6}},e.arbitrumUSDC={network:'eip155:42161',asset:'0xaf88d065e77c8cC2239327C5EDb3A432268e5831',metadata:{name:'USD Coin',symbol:'USDC',decimals:6}},e.polygonUSDC={network:'eip155:137',asset:'0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',metadata:{name:'USD Coin',symbol:'USDC',decimals:6}},e.solanaUSDC={network:'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',asset:'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',metadata:{name:'USD Coin',symbol:'USDC',decimals:6}},e.ethereumUSDT={network:'eip155:1',asset:'0xdAC17F958D2ee523a2206206994597C13D831ec7',metadata:{name:'Tether USD',symbol:'USDT',decimals:6}},e.optimismUSDT={network:'eip155:10',asset:'0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',metadata:{name:'Tether USD',symbol:'USDT',decimals:6}},e.arbitrumUSDT={network:'eip155:42161',asset:'0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',metadata:{name:'Tether USD',symbol:'USDT',decimals:6}},e.polygonUSDT={network:'eip155:137',asset:'0xc2132d05d31c914a87c6611c10748aeb04b58e8f',metadata:{name:'Tether USD',symbol:'USDT',decimals:6}},e.solanaUSDT={network:'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',asset:'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',metadata:{name:'Tether USD',symbol:'USDT',decimals:6}},e.solanaSOL={network:'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',asset:'native',metadata:{name:'Solana',symbol:'SOL',decimals:9}}},6246,[]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var o=r(d[0]);e.default=o.css`
  wui-image {
    border-radius: ${({borderRadius:o})=>o.round};
  }

  .transfers-badge {
    background-color: ${({tokens:o})=>o.theme.foregroundPrimary};
    border: 1px solid ${({tokens:o})=>o.theme.foregroundSecondary};
    border-radius: ${({borderRadius:o})=>o[4]};
  }
`},6247,[4650]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var o=r(d[0]);e.default=o.css`
  :host {
    height: 60px;
  }

  :host > wui-flex {
    box-sizing: border-box;
    background-color: var(--local-header-background-color);
  }

  wui-text {
    background-color: var(--local-header-background-color);
  }

  wui-flex.w3m-header-title {
    transform: translateY(0);
    opacity: 1;
  }

  wui-flex.w3m-header-title[view-direction='prev'] {
    animation:
      slide-down-out 120ms forwards ${({easings:o})=>o['ease-out-power-2']},
      slide-down-in 120ms forwards ${({easings:o})=>o['ease-out-power-2']};
    animation-delay: 0ms, 200ms;
  }

  wui-flex.w3m-header-title[view-direction='next'] {
    animation:
      slide-up-out 120ms forwards ${({easings:o})=>o['ease-out-power-2']},
      slide-up-in 120ms forwards ${({easings:o})=>o['ease-out-power-2']};
    animation-delay: 0ms, 200ms;
  }

  wui-icon-button[data-hidden='true'] {
    opacity: 0 !important;
    pointer-events: none;
  }

  @keyframes slide-up-out {
    from {
      transform: translateY(0px);
      opacity: 1;
    }
    to {
      transform: translateY(3px);
      opacity: 0;
    }
  }

  @keyframes slide-up-in {
    from {
      transform: translateY(-3px);
      opacity: 0;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }

  @keyframes slide-down-out {
    from {
      transform: translateY(0px);
      opacity: 1;
    }
    to {
      transform: translateY(-3px);
      opacity: 0;
    }
  }

  @keyframes slide-down-in {
    from {
      transform: translateY(3px);
      opacity: 0;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }
`},6248,[4650]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.W3mSnackBar=void 0;var r=_r(_d[1]),s=_r(_d[2]),o=_r(_d[3]),n=_r(_d[4]);_r(_d[5]);var i=t(_r(_d[6])),c=this&&this.__decorate||function(t,r,s,o){var n,i=arguments.length,c=i<3?r:null===o?o=Object.getOwnPropertyDescriptor(r,s):o;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)c=Reflect.decorate(t,r,s,o);else for(var l=t.length-1;l>=0;l--)(n=t[l])&&(c=(i<3?n(c):i>3?n(r,s,c):n(r,s))||c);return i>3&&c&&Object.defineProperty(r,s,c),c};let l=e.W3mSnackBar=class extends r.LitElement{constructor(){super(),this.unsubscribe=[],this.timeout=void 0,this.open=o.SnackController.state.open,this.unsubscribe.push(o.SnackController.subscribeKey('open',t=>{this.open=t,this.onOpen()}))}disconnectedCallback(){clearTimeout(this.timeout),this.unsubscribe.forEach(t=>t())}render(){const{message:t,variant:s}=o.SnackController.state;return r.html` <wui-snackbar message=${t} variant=${s}></wui-snackbar> `}onOpen(){clearTimeout(this.timeout),this.open?(this.animate([{opacity:0,transform:'translateX(-50%) scale(0.85)'},{opacity:1,transform:'translateX(-50%) scale(1)'}],{duration:150,fill:'forwards',easing:'ease'}),this.timeout&&clearTimeout(this.timeout),o.SnackController.state.autoClose&&(this.timeout=setTimeout(()=>o.SnackController.hide(),2500))):this.animate([{opacity:1,transform:'translateX(-50%) scale(1)'},{opacity:0,transform:'translateX(-50%) scale(0.85)'}],{duration:150,fill:'forwards',easing:'ease'})}};l.styles=i.default,c([(0,s.state)()],l.prototype,"open",void 0),e.W3mSnackBar=l=c([(0,n.customElement)('w3m-snackbar')],l)},6249,[2,4653,4674,4632,4650,6250,6253]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0});var n=r(d[0]);Object.keys(n).forEach(function(t){"default"!==t&&"__esModule"!==t&&(t in e&&e[t]===n[t]||Object.defineProperty(e,t,{enumerable:!0,get:function(){return n[t]}}))})},6250,[6251]);
__d(function(g,_r,_i,a,m,e,_d){var r=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.WuiSnackbar=void 0;var t=_r(_d[1]),i=_r(_d[2]);_r(_d[3]),_r(_d[4]);var n=_r(_d[5]),o=_r(_d[6]);_r(_d[7]);var s=r(_r(_d[8])),c=this&&this.__decorate||function(r,t,i,n){var o,s=arguments.length,c=s<3?t:null===n?n=Object.getOwnPropertyDescriptor(t,i):n;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)c=Reflect.decorate(r,t,i,n);else for(var l=r.length-1;l>=0;l--)(o=r[l])&&(c=(s<3?o(c):s>3?o(t,i,c):o(t,i))||c);return s>3&&c&&Object.defineProperty(t,i,c),c};let l=e.WuiSnackbar=class extends t.LitElement{constructor(){super(...arguments),this.message='',this.variant='success'}render(){return t.html`
      ${this.templateIcon()}
      <wui-text variant="lg-regular" color="primary" data-testid="wui-snackbar-message"
        >${this.message}</wui-text
      >
    `}templateIcon(){return'loading'===this.variant?t.html`<wui-loading-spinner size="md" color="accent-primary"></wui-loading-spinner>`:t.html`<wui-icon-box
      size="md"
      color=${{success:'success',error:'error',warning:'warning',info:'default'}[this.variant]}
      icon=${{success:'checkmark',error:'warning',warning:'warningCircle',info:'info'}[this.variant]}
    ></wui-icon-box>`}};l.styles=[n.resetStyles,s.default],c([(0,i.property)()],l.prototype,"message",void 0),c([(0,i.property)()],l.prototype,"variant",void 0),e.WuiSnackbar=l=c([(0,o.customElement)('wui-snackbar')],l)},6251,[2,4653,4674,4740,4722,4652,4663,4727,6252]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var o=r(d[0]);e.default=o.css`
  :host {
    display: flex;
    align-items: center;
    gap: ${({spacing:o})=>o[1]};
    padding: ${({spacing:o})=>o[2]} ${({spacing:o})=>o[3]}
      ${({spacing:o})=>o[2]} ${({spacing:o})=>o[2]};
    border-radius: ${({borderRadius:o})=>o[20]};
    background-color: ${({tokens:o})=>o.theme.foregroundPrimary};
    box-shadow:
      0px 0px 8px 0px rgba(0, 0, 0, 0.1),
      inset 0 0 0 1px ${({tokens:o})=>o.theme.borderPrimary};
    max-width: 320px;
  }

  wui-icon-box {
    border-radius: ${({borderRadius:o})=>o.round} !important;
    overflow: hidden;
  }

  wui-loading-spinner {
    padding: ${({spacing:o})=>o[1]};
    background-color: ${({tokens:o})=>o.core.foregroundAccent010};
    border-radius: ${({borderRadius:o})=>o.round} !important;
  }
`},6252,[4659]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var t=r(d[0]);e.default=t.css`
  :host {
    display: block;
    position: absolute;
    opacity: 0;
    pointer-events: none;
    top: 11px;
    left: 50%;
    width: max-content;
  }
`},6253,[4653]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.WuiTooltipTrigger=void 0;var o=_r(_d[1]),i=_r(_d[2]),r=_r(_d[3]),n=_r(_d[4]),l=t(_r(_d[5])),s=this&&this.__decorate||function(t,o,i,r){var n,l=arguments.length,s=l<3?o:null===r?r=Object.getOwnPropertyDescriptor(o,i):r;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)s=Reflect.decorate(t,o,i,r);else for(var h=t.length-1;h>=0;h--)(n=t[h])&&(s=(l<3?n(s):l>3?n(o,i,s):n(o,i))||s);return l>3&&s&&Object.defineProperty(o,i,s),s};let h=e.WuiTooltipTrigger=class extends o.LitElement{constructor(){super(),this.unsubscribe=[],this.text='',this.open=r.TooltipController.state.open,this.unsubscribe.push(r.RouterController.subscribeKey('view',()=>{r.TooltipController.hide()}),r.ModalController.subscribeKey('open',t=>{t||r.TooltipController.hide()}),r.TooltipController.subscribeKey('open',t=>{this.open=t}))}disconnectedCallback(){this.unsubscribe.forEach(t=>t()),r.TooltipController.hide()}render(){return o.html`
      <div
        @pointermove=${this.onMouseEnter.bind(this)}
        @pointerleave=${this.onMouseLeave.bind(this)}
      >
        ${this.renderChildren()}
      </div>
    `}renderChildren(){return o.html`<slot></slot> `}onMouseEnter(){const t=this.getBoundingClientRect();if(!this.open){const o=document.querySelector('w3m-modal'),i={width:t.width,height:t.height,left:t.left,top:t.top};if(o){const r=o.getBoundingClientRect();i.left=t.left-(window.innerWidth-r.width)/2,i.top=t.top-(window.innerHeight-r.height)/2}r.TooltipController.showTooltip({message:this.text,triggerRect:i,variant:'shade'})}}onMouseLeave(t){this.contains(t.relatedTarget)||r.TooltipController.hide()}};h.styles=[l.default],s([(0,i.property)()],h.prototype,"text",void 0),s([(0,i.state)()],h.prototype,"open",void 0),e.WuiTooltipTrigger=h=s([(0,n.customElement)('w3m-tooltip-trigger')],h)},6254,[2,4653,4674,4632,4650,6255]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var t=r(d[0]);e.default=t.css`
  :host {
    width: 100%;
    display: block;
  }
`},6255,[4653]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.W3mTooltip=void 0;var o=_r(_d[1]),i=_r(_d[2]),r=_r(_d[3]),s=_r(_d[4]);_r(_d[5]),_r(_d[6]),_r(_d[7]);var n=t(_r(_d[8])),l=this&&this.__decorate||function(t,o,i,r){var s,n=arguments.length,l=n<3?o:null===r?r=Object.getOwnPropertyDescriptor(o,i):r;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)l=Reflect.decorate(t,o,i,r);else for(var p=t.length-1;p>=0;p--)(s=t[p])&&(l=(n<3?s(l):n>3?s(o,i,l):s(o,i))||l);return n>3&&l&&Object.defineProperty(o,i,l),l};let p=e.W3mTooltip=class extends o.LitElement{constructor(){super(),this.unsubscribe=[],this.open=r.TooltipController.state.open,this.message=r.TooltipController.state.message,this.triggerRect=r.TooltipController.state.triggerRect,this.variant=r.TooltipController.state.variant,this.unsubscribe.push(r.TooltipController.subscribe(t=>{this.open=t.open,this.message=t.message,this.triggerRect=t.triggerRect,this.variant=t.variant}))}disconnectedCallback(){this.unsubscribe.forEach(t=>t())}render(){this.dataset.variant=this.variant;const t=this.triggerRect.top,i=this.triggerRect.left;return this.style.cssText=`\n    --w3m-tooltip-top: ${t}px;\n    --w3m-tooltip-left: ${i}px;\n    --w3m-tooltip-parent-width: ${this.triggerRect.width/2}px;\n    --w3m-tooltip-display: ${this.open?'flex':'none'};\n    --w3m-tooltip-opacity: ${this.open?1:0};\n    `,o.html`<wui-flex>
      <wui-icon data-placement="top" size="inherit" name="cursor"></wui-icon>
      <wui-text color="primary" variant="sm-regular">${this.message}</wui-text>
    </wui-flex>`}};p.styles=[n.default],l([(0,i.state)()],p.prototype,"open",void 0),l([(0,i.state)()],p.prototype,"message",void 0),l([(0,i.state)()],p.prototype,"triggerRect",void 0),l([(0,i.state)()],p.prototype,"variant",void 0),e.W3mTooltip=p=l([(0,s.customElement)('w3m-tooltip')],p)},6256,[2,4653,4674,4632,4650,4685,4743,4747,6257]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var t=r(d[0]);e.default=t.css`
  :host {
    pointer-events: none;
  }

  :host > wui-flex {
    display: var(--w3m-tooltip-display);
    opacity: var(--w3m-tooltip-opacity);
    padding: 9px ${({spacing:t})=>t[3]} 10px ${({spacing:t})=>t[3]};
    border-radius: ${({borderRadius:t})=>t[3]};
    color: ${({tokens:t})=>t.theme.backgroundPrimary};
    position: absolute;
    top: var(--w3m-tooltip-top);
    left: var(--w3m-tooltip-left);
    transform: translate(calc(-50% + var(--w3m-tooltip-parent-width)), calc(-100% - 8px));
    max-width: calc(var(--apkt-modal-width) - ${({spacing:t})=>t[5]});
    transition: opacity ${({durations:t})=>t.lg}
      ${({easings:t})=>t['ease-out-power-2']};
    will-change: opacity;
    opacity: 0;
    animation-duration: ${({durations:t})=>t.xl};
    animation-timing-function: ${({easings:t})=>t['ease-out-power-2']};
    animation-name: fade-in;
    animation-fill-mode: forwards;
  }

  :host([data-variant='shade']) > wui-flex {
    background-color: ${({tokens:t})=>t.theme.foregroundPrimary};
  }

  :host([data-variant='shade']) > wui-flex > wui-text {
    color: ${({tokens:t})=>t.theme.textSecondary};
  }

  :host([data-variant='fill']) > wui-flex {
    background-color: ${({tokens:t})=>t.theme.backgroundPrimary};
    border: 1px solid ${({tokens:t})=>t.theme.borderPrimary};
  }

  wui-icon {
    position: absolute;
    width: 12px !important;
    height: 4px !important;
    color: ${({tokens:t})=>t.theme.foregroundPrimary};
  }

  wui-icon[data-placement='top'] {
    bottom: 0px;
    left: 50%;
    transform: translate(-50%, 95%);
  }

  wui-icon[data-placement='bottom'] {
    top: 0;
    left: 50%;
    transform: translate(-50%, -95%) rotate(180deg);
  }

  wui-icon[data-placement='right'] {
    top: 50%;
    left: 0;
    transform: translate(-65%, -50%) rotate(90deg);
  }

  wui-icon[data-placement='left'] {
    top: 50%;
    right: 0%;
    transform: translate(65%, -50%) rotate(270deg);
  }

  @keyframes fade-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
`},6257,[4650]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.HelpersUtil=void 0;var t=r(d[0]),s=r(d[1]),l=r(d[2]);e.HelpersUtil={getTabsByNamespace:o=>Boolean(o)&&o===t.ConstantsUtil.CHAIN.EVM?!1===s.OptionsController.state.remoteFeatures?.activity?l.ConstantsUtil.ACCOUNT_TABS.filter(t=>'Activity'!==t.label):l.ConstantsUtil.ACCOUNT_TABS:[],isValidReownName:t=>/^[a-zA-Z0-9]+$/gu.test(t),isValidEmail:t=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/gu.test(t),validateReownName:t=>t.replace(/\^/gu,'').toLowerCase().replace(/[^a-zA-Z0-9]/gu,''),hasFooter(){const t=s.RouterController.state.view;if(l.ConstantsUtil.VIEWS_WITH_LEGAL_FOOTER.includes(t)){const{termsConditionsUrl:t,privacyPolicyUrl:l}=s.OptionsController.state,o=s.OptionsController.state.features?.legalCheckbox;return!(!t&&!l||o)}return l.ConstantsUtil.VIEWS_WITH_DEFAULT_FOOTER.includes(t)}}},6258,[4556,4632,6199]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.W3mFooter=void 0;var r=_r(_d[1]),o=_r(_d[2]),s=_r(_d[3]),i=_r(_d[4]);_r(_d[5]),_r(_d[6]);var n=_r(_d[7]),l=t(_r(_d[8])),c=this&&this.__decorate||function(t,r,o,s){var i,n=arguments.length,l=n<3?r:null===s?s=Object.getOwnPropertyDescriptor(r,o):s;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)l=Reflect.decorate(t,r,o,s);else for(var c=t.length-1;c>=0;c--)(i=t[c])&&(l=(n<3?i(l):n>3?i(r,o,l):i(r,o))||l);return n>3&&l&&Object.defineProperty(r,o,l),l};let u=e.W3mFooter=class extends r.LitElement{constructor(){super(...arguments),this.resizeObserver=void 0,this.unsubscribe=[],this.status='hide',this.view=s.RouterController.state.view}firstUpdated(){this.status=n.HelpersUtil.hasFooter()?'show':'hide',this.unsubscribe.push(s.RouterController.subscribeKey('view',t=>{if(this.view=t,this.status=n.HelpersUtil.hasFooter()?'show':'hide','hide'===this.status){document.documentElement.style.setProperty('--apkt-footer-height','0px')}})),this.resizeObserver=new ResizeObserver(t=>{for(const r of t)if(r.target===this.getWrapper()){const t=`${r.contentRect.height}px`;document.documentElement.style.setProperty('--apkt-footer-height',t)}}),this.resizeObserver.observe(this.getWrapper())}render(){return r.html`
      <div class="container" status=${this.status}>${this.templatePageContainer()}</div>
    `}templatePageContainer(){return n.HelpersUtil.hasFooter()?r.html` ${this.templateFooter()}`:null}templateFooter(){switch(this.view){case'Networks':return this.templateNetworksFooter();case'Connect':case'ConnectWallets':case'OnRampFiatSelect':case'OnRampTokenSelect':return r.html`<w3m-legal-footer></w3m-legal-footer>`;case'OnRampProviders':return r.html`<w3m-onramp-providers-footer></w3m-onramp-providers-footer>`;default:return null}}templateNetworksFooter(){return r.html` <wui-flex
      class="footer-in"
      padding="3"
      flexDirection="column"
      gap="3"
      alignItems="center"
    >
      <wui-text variant="md-regular" color="secondary" align="center">
        Your connected wallet may not support some of the networks available for this dApp
      </wui-text>
      <wui-link @click=${this.onNetworkHelp.bind(this)}>
        <wui-icon size="sm" color="accent-primary" slot="iconLeft" name="helpCircle"></wui-icon>
        What is a network
      </wui-link>
    </wui-flex>`}onNetworkHelp(){s.EventsController.sendEvent({type:'track',event:'CLICK_NETWORK_HELP'}),s.RouterController.push('WhatIsANetwork')}getWrapper(){return this.shadowRoot?.querySelector('div.container')}};u.styles=[l.default],c([(0,o.state)()],u.prototype,"status",void 0),c([(0,o.state)()],u.prototype,"view",void 0),e.W3mFooter=u=c([(0,i.customElement)('w3m-footer')],u)},6259,[2,4653,4674,4632,4650,6260,6262,6258,6264]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.W3mLegalFooter=void 0;var r=_r(_d[1]),o=_r(_d[2]),n=_r(_d[3]),l=_r(_d[4]);_r(_d[5]),_r(_d[6]),_r(_d[7]);var i=t(_r(_d[8])),s=this&&this.__decorate||function(t,r,o,n){var l,i=arguments.length,s=i<3?r:null===n?n=Object.getOwnPropertyDescriptor(r,o):n;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)s=Reflect.decorate(t,r,o,n);else for(var u=t.length-1;u>=0;u--)(l=t[u])&&(s=(i<3?l(s):i>3?l(r,o,s):l(r,o))||s);return i>3&&s&&Object.defineProperty(r,o,s),s};let u=e.W3mLegalFooter=class extends r.LitElement{constructor(){super(),this.unsubscribe=[],this.remoteFeatures=n.OptionsController.state.remoteFeatures,this.unsubscribe.push(n.OptionsController.subscribeKey('remoteFeatures',t=>this.remoteFeatures=t))}disconnectedCallback(){this.unsubscribe.forEach(t=>t())}render(){const{termsConditionsUrl:t,privacyPolicyUrl:o}=n.OptionsController.state,l=n.OptionsController.state.features?.legalCheckbox;return!t&&!o||l?r.html`
        <wui-flex flexDirection="column"> ${this.reownBrandingTemplate(!0)} </wui-flex>
      `:r.html`
      <wui-flex flexDirection="column">
        <wui-flex .padding=${['4','3','3','3']} justifyContent="center">
          <wui-text color="secondary" variant="md-regular" align="center">
            By connecting your wallet, you agree to our <br />
            ${this.termsTemplate()} ${this.andTemplate()} ${this.privacyTemplate()}
          </wui-text>
        </wui-flex>
        ${this.reownBrandingTemplate()}
      </wui-flex>
    `}andTemplate(){const{termsConditionsUrl:t,privacyPolicyUrl:r}=n.OptionsController.state;return t&&r?'and':''}termsTemplate(){const{termsConditionsUrl:t}=n.OptionsController.state;return t?r.html`<a href=${t} target="_blank" rel="noopener noreferrer"
      >Terms of Service</a
    >`:null}privacyTemplate(){const{privacyPolicyUrl:t}=n.OptionsController.state;return t?r.html`<a href=${t} target="_blank" rel="noopener noreferrer"
      >Privacy Policy</a
    >`:null}reownBrandingTemplate(t=!1){return this.remoteFeatures?.reownBranding?t?r.html`<wui-ux-by-reown class="branding-only"></wui-ux-by-reown>`:r.html`<wui-ux-by-reown></wui-ux-by-reown>`:null}};u.styles=[i.default],s([(0,o.state)()],u.prototype,"remoteFeatures",void 0),e.W3mLegalFooter=u=s([(0,l.customElement)('w3m-legal-footer')],u)},6260,[2,4653,4674,4632,4650,4685,4747,4752,6261]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var o=r(d[0]);e.default=o.css`
  :host wui-ux-by-reown {
    padding-top: 0;
  }

  :host wui-ux-by-reown.branding-only {
    padding-top: ${({spacing:o})=>o[3]};
  }

  a {
    text-decoration: none;
    color: ${({tokens:o})=>o.core.textAccentPrimary};
    font-weight: 500;
  }
`},6261,[4650]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.W3mOnRampProvidersFooter=void 0;var o=_r(_d[1]),r=_r(_d[2]),n=_r(_d[3]);_r(_d[4]),_r(_d[5]),_r(_d[6]),_r(_d[7]);var i=_r(_d[8]),s=t(_r(_d[9])),l=this&&this.__decorate||function(t,o,r,n){var i,s=arguments.length,l=s<3?o:null===n?n=Object.getOwnPropertyDescriptor(o,r):n;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)l=Reflect.decorate(t,o,r,n);else for(var c=t.length-1;c>=0;c--)(i=t[c])&&(l=(s<3?i(l):s>3?i(o,r,l):i(o,r))||l);return s>3&&l&&Object.defineProperty(o,r,l),l};let c=e.W3mOnRampProvidersFooter=class extends o.LitElement{render(){const{termsConditionsUrl:t,privacyPolicyUrl:n}=r.OptionsController.state;return t||n?o.html`
      <wui-flex
        .padding=${['4','3','3','3']}
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
        gap="3"
      >
        <wui-text color="secondary" variant="md-regular" align="center">
          We work with the best providers to give you the lowest fees and best support. More options
          coming soon!
        </wui-text>

        ${this.howDoesItWorkTemplate()}
      </wui-flex>
    `:null}howDoesItWorkTemplate(){return o.html` <wui-link @click=${this.onWhatIsBuy.bind(this)}>
      <wui-icon size="xs" color="accent-primary" slot="iconLeft" name="helpCircle"></wui-icon>
      How does it work?
    </wui-link>`}onWhatIsBuy(){r.EventsController.sendEvent({type:'track',event:'SELECT_WHAT_IS_A_BUY',properties:{isSmartAccount:(0,r.getPreferredAccountType)(r.ChainController.state.activeChain)===i.W3mFrameRpcConstants.ACCOUNT_TYPES.SMART_ACCOUNT}}),r.RouterController.push('WhatIsABuy')}};c.styles=[s.default],e.W3mOnRampProvidersFooter=c=l([(0,n.customElement)('w3m-onramp-providers-footer')],c)},6262,[2,4653,4632,4650,4685,4743,4744,4747,4610,6263]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var t=r(d[0]);e.default=t.css``},6263,[4653]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var t=r(d[0]);e.default=t.css`
  :host {
    display: block;
  }

  div.container {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    overflow: hidden;
    height: auto;
    display: block;
  }

  div.container[status='hide'] {
    animation: fade-out;
    animation-duration: var(--apkt-duration-dynamic);
    animation-timing-function: ${({easings:t})=>t['ease-out-power-2']};
    animation-fill-mode: both;
    animation-delay: 0s;
  }

  div.container[status='show'] {
    animation: fade-in;
    animation-duration: var(--apkt-duration-dynamic);
    animation-timing-function: ${({easings:t})=>t['ease-out-power-2']};
    animation-fill-mode: both;
    animation-delay: var(--apkt-duration-dynamic);
  }

  @keyframes fade-in {
    from {
      opacity: 0;
      filter: blur(6px);
    }
    to {
      opacity: 1;
      filter: blur(0px);
    }
  }

  @keyframes fade-out {
    from {
      opacity: 1;
      filter: blur(0px);
    }
    to {
      opacity: 0;
      filter: blur(6px);
    }
  }
`},6264,[4650]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.W3mRouter=void 0;var i=_r(_d[1]),w=_r(_d[2]),n=_r(_d[3]),r=_r(_d[4]);_r(_d[5]);var s=t(_r(_d[6])),c=this&&this.__decorate||function(t,i,w,n){var r,s=arguments.length,c=s<3?i:null===n?n=Object.getOwnPropertyDescriptor(i,w):n;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)c=Reflect.decorate(t,i,w,n);else for(var l=t.length-1;l>=0;l--)(r=t[l])&&(c=(s<3?r(c):s>3?r(i,w,c):r(i,w))||c);return s>3&&c&&Object.defineProperty(i,w,c),c};let l=e.W3mRouter=class extends i.LitElement{constructor(){super(),this.unsubscribe=[],this.viewState=n.RouterController.state.view,this.history=n.RouterController.state.history.join(','),this.unsubscribe.push(n.RouterController.subscribeKey('view',()=>{this.history=n.RouterController.state.history.join(','),document.documentElement.style.setProperty('--apkt-duration-dynamic','var(--apkt-durations-lg)')}))}disconnectedCallback(){this.unsubscribe.forEach(t=>t()),document.documentElement.style.setProperty('--apkt-duration-dynamic','0s')}render(){return i.html`${this.templatePageContainer()}`}templatePageContainer(){return i.html`<w3m-router-container
      history=${this.history}
      .setView=${()=>{this.viewState=n.RouterController.state.view}}
    >
      ${this.viewTemplate(this.viewState)}
    </w3m-router-container>`}viewTemplate(t){switch(t){case'AccountSettings':return i.html`<w3m-account-settings-view></w3m-account-settings-view>`;case'Account':return i.html`<w3m-account-view></w3m-account-view>`;case'AllWallets':return i.html`<w3m-all-wallets-view></w3m-all-wallets-view>`;case'ApproveTransaction':return i.html`<w3m-approve-transaction-view></w3m-approve-transaction-view>`;case'BuyInProgress':return i.html`<w3m-buy-in-progress-view></w3m-buy-in-progress-view>`;case'ChooseAccountName':return i.html`<w3m-choose-account-name-view></w3m-choose-account-name-view>`;case'Connect':default:return i.html`<w3m-connect-view></w3m-connect-view>`;case'Create':return i.html`<w3m-connect-view walletGuide="explore"></w3m-connect-view>`;case'ConnectingWalletConnect':return i.html`<w3m-connecting-wc-view></w3m-connecting-wc-view>`;case'ConnectingWalletConnectBasic':return i.html`<w3m-connecting-wc-basic-view></w3m-connecting-wc-basic-view>`;case'ConnectingExternal':return i.html`<w3m-connecting-external-view></w3m-connecting-external-view>`;case'ConnectingSiwe':return i.html`<w3m-connecting-siwe-view></w3m-connecting-siwe-view>`;case'ConnectWallets':return i.html`<w3m-connect-wallets-view></w3m-connect-wallets-view>`;case'ConnectSocials':return i.html`<w3m-connect-socials-view></w3m-connect-socials-view>`;case'ConnectingSocial':return i.html`<w3m-connecting-social-view></w3m-connecting-social-view>`;case'DataCapture':return i.html`<w3m-data-capture-view></w3m-data-capture-view>`;case'DataCaptureOtpConfirm':return i.html`<w3m-data-capture-otp-confirm-view></w3m-data-capture-otp-confirm-view>`;case'Downloads':return i.html`<w3m-downloads-view></w3m-downloads-view>`;case'EmailLogin':return i.html`<w3m-email-login-view></w3m-email-login-view>`;case'EmailVerifyOtp':return i.html`<w3m-email-verify-otp-view></w3m-email-verify-otp-view>`;case'EmailVerifyDevice':return i.html`<w3m-email-verify-device-view></w3m-email-verify-device-view>`;case'GetWallet':return i.html`<w3m-get-wallet-view></w3m-get-wallet-view>`;case'Networks':return i.html`<w3m-networks-view></w3m-networks-view>`;case'SwitchNetwork':return i.html`<w3m-network-switch-view></w3m-network-switch-view>`;case'ProfileWallets':return i.html`<w3m-profile-wallets-view></w3m-profile-wallets-view>`;case'Transactions':return i.html`<w3m-transactions-view></w3m-transactions-view>`;case'OnRampProviders':return i.html`<w3m-onramp-providers-view></w3m-onramp-providers-view>`;case'OnRampTokenSelect':return i.html`<w3m-onramp-token-select-view></w3m-onramp-token-select-view>`;case'OnRampFiatSelect':return i.html`<w3m-onramp-fiat-select-view></w3m-onramp-fiat-select-view>`;case'UpgradeEmailWallet':return i.html`<w3m-upgrade-wallet-view></w3m-upgrade-wallet-view>`;case'UpdateEmailWallet':return i.html`<w3m-update-email-wallet-view></w3m-update-email-wallet-view>`;case'UpdateEmailPrimaryOtp':return i.html`<w3m-update-email-primary-otp-view></w3m-update-email-primary-otp-view>`;case'UpdateEmailSecondaryOtp':return i.html`<w3m-update-email-secondary-otp-view></w3m-update-email-secondary-otp-view>`;case'UnsupportedChain':return i.html`<w3m-unsupported-chain-view></w3m-unsupported-chain-view>`;case'Swap':return i.html`<w3m-swap-view></w3m-swap-view>`;case'SwapSelectToken':return i.html`<w3m-swap-select-token-view></w3m-swap-select-token-view>`;case'SwapPreview':return i.html`<w3m-swap-preview-view></w3m-swap-preview-view>`;case'WalletSend':return i.html`<w3m-wallet-send-view></w3m-wallet-send-view>`;case'WalletSendSelectToken':return i.html`<w3m-wallet-send-select-token-view></w3m-wallet-send-select-token-view>`;case'WalletSendPreview':return i.html`<w3m-wallet-send-preview-view></w3m-wallet-send-preview-view>`;case'WalletSendConfirmed':return i.html`<w3m-send-confirmed-view></w3m-send-confirmed-view>`;case'WhatIsABuy':return i.html`<w3m-what-is-a-buy-view></w3m-what-is-a-buy-view>`;case'WalletReceive':return i.html`<w3m-wallet-receive-view></w3m-wallet-receive-view>`;case'WalletCompatibleNetworks':return i.html`<w3m-wallet-compatible-networks-view></w3m-wallet-compatible-networks-view>`;case'WhatIsAWallet':return i.html`<w3m-what-is-a-wallet-view></w3m-what-is-a-wallet-view>`;case'ConnectingMultiChain':return i.html`<w3m-connecting-multi-chain-view></w3m-connecting-multi-chain-view>`;case'WhatIsANetwork':return i.html`<w3m-what-is-a-network-view></w3m-what-is-a-network-view>`;case'ConnectingFarcaster':return i.html`<w3m-connecting-farcaster-view></w3m-connecting-farcaster-view>`;case'SwitchActiveChain':return i.html`<w3m-switch-active-chain-view></w3m-switch-active-chain-view>`;case'RegisterAccountName':return i.html`<w3m-register-account-name-view></w3m-register-account-name-view>`;case'RegisterAccountNameSuccess':return i.html`<w3m-register-account-name-success-view></w3m-register-account-name-success-view>`;case'SmartSessionCreated':return i.html`<w3m-smart-session-created-view></w3m-smart-session-created-view>`;case'SmartSessionList':return i.html`<w3m-smart-session-list-view></w3m-smart-session-list-view>`;case'SIWXSignMessage':return i.html`<w3m-siwx-sign-message-view></w3m-siwx-sign-message-view>`;case'Pay':return i.html`<w3m-pay-view></w3m-pay-view>`;case'PayLoading':return i.html`<w3m-pay-loading-view></w3m-pay-loading-view>`;case'PayQuote':return i.html`<w3m-pay-quote-view></w3m-pay-quote-view>`;case'FundWallet':return i.html`<w3m-fund-wallet-view></w3m-fund-wallet-view>`;case'PayWithExchange':return i.html`<w3m-deposit-from-exchange-view></w3m-deposit-from-exchange-view>`;case'PayWithExchangeSelectAsset':return i.html`<w3m-deposit-from-exchange-select-asset-view></w3m-deposit-from-exchange-select-asset-view>`;case'UsageExceeded':return i.html`<w3m-usage-exceeded-view></w3m-usage-exceeded-view>`;case'SmartAccountSettings':return i.html`<w3m-smart-account-settings-view></w3m-smart-account-settings-view>`}}};l.styles=[s.default],c([(0,w.state)()],l.prototype,"viewState",void 0),c([(0,w.state)()],l.prototype,"history",void 0),e.W3mRouter=l=c([(0,r.customElement)('w3m-router')],l)},6265,[2,4653,4674,4632,4650,6259,6266]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var t=r(d[0]);e.default=t.css`
  :host {
    display: block;
    width: inherit;
  }
`},6266,[4650]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var o=r(d[0]);e.default=o.css`
  :host {
    z-index: ${({tokens:o})=>o.core.zIndex};
    display: block;
    backface-visibility: hidden;
    will-change: opacity;
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    pointer-events: none;
    opacity: 0;
    background-color: ${({tokens:o})=>o.theme.overlay};
    backdrop-filter: blur(0px);
    transition:
      opacity ${({durations:o})=>o.lg} ${({easings:o})=>o['ease-out-power-2']},
      backdrop-filter ${({durations:o})=>o.lg}
        ${({easings:o})=>o['ease-out-power-2']};
    will-change: opacity;
  }

  :host(.open) {
    opacity: 1;
    backdrop-filter: blur(8px);
  }

  :host(.appkit-modal) {
    position: relative;
    pointer-events: unset;
    background: none;
    width: 100%;
    opacity: 1;
  }

  wui-card {
    max-width: var(--apkt-modal-width);
    width: 100%;
    position: relative;
    outline: none;
    transform: translateY(4px);
    box-shadow: 0 2px 8px 0 rgba(0, 0, 0, 0.05);
    transition:
      transform ${({durations:o})=>o.lg}
        ${({easings:o})=>o['ease-out-power-2']},
      border-radius ${({durations:o})=>o.lg}
        ${({easings:o})=>o['ease-out-power-1']},
      background-color ${({durations:o})=>o.lg}
        ${({easings:o})=>o['ease-out-power-1']},
      box-shadow ${({durations:o})=>o.lg}
        ${({easings:o})=>o['ease-out-power-1']};
    will-change: border-radius, background-color, transform, box-shadow;
    background-color: ${({tokens:o})=>o.theme.backgroundPrimary};
    padding: var(--local-modal-padding);
    box-sizing: border-box;
  }

  :host(.open) wui-card {
    transform: translateY(0px);
  }

  wui-card::before {
    z-index: 1;
    pointer-events: none;
    content: '';
    position: absolute;
    inset: 0;
    border-radius: clamp(0px, var(--apkt-borderRadius-8), 44px);
    transition: box-shadow ${({durations:o})=>o.lg}
      ${({easings:o})=>o['ease-out-power-2']};
    transition-delay: ${({durations:o})=>o.md};
    will-change: box-shadow;
  }

  :host([data-mobile-fullscreen='true']) wui-card::before {
    border-radius: 0px;
  }

  :host([data-border='true']) wui-card::before {
    box-shadow: inset 0px 0px 0px 4px ${({tokens:o})=>o.theme.foregroundSecondary};
  }

  :host([data-border='false']) wui-card::before {
    box-shadow: inset 0px 0px 0px 1px ${({tokens:o})=>o.theme.borderPrimaryDark};
  }

  :host([data-border='true']) wui-card {
    animation:
      fade-in ${({durations:o})=>o.lg} ${({easings:o})=>o['ease-out-power-2']},
      card-background-border var(--apkt-duration-dynamic)
        ${({easings:o})=>o['ease-out-power-2']};
    animation-fill-mode: backwards, both;
    animation-delay: var(--apkt-duration-dynamic);
  }

  :host([data-border='false']) wui-card {
    animation:
      fade-in ${({durations:o})=>o.lg} ${({easings:o})=>o['ease-out-power-2']},
      card-background-default var(--apkt-duration-dynamic)
        ${({easings:o})=>o['ease-out-power-2']};
    animation-fill-mode: backwards, both;
    animation-delay: 0s;
  }

  :host(.appkit-modal) wui-card {
    max-width: var(--apkt-modal-width);
  }

  wui-card[shake='true'] {
    animation:
      fade-in ${({durations:o})=>o.lg} ${({easings:o})=>o['ease-out-power-2']},
      w3m-shake ${({durations:o})=>o.xl}
        ${({easings:o})=>o['ease-out-power-2']};
  }

  wui-flex {
    overflow-x: hidden;
    overflow-y: auto;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
  }

  @media (max-height: 700px) and (min-width: 431px) {
    wui-flex {
      align-items: flex-start;
    }

    wui-card {
      margin: var(--apkt-spacing-6) 0px;
    }
  }

  @media (max-width: 430px) {
    :host([data-mobile-fullscreen='true']) {
      height: 100dvh;
    }
    :host([data-mobile-fullscreen='true']) wui-flex {
      align-items: stretch;
    }
    :host([data-mobile-fullscreen='true']) wui-card {
      max-width: 100%;
      height: 100%;
      border-radius: 0;
      border: none;
    }
    :host(:not([data-mobile-fullscreen='true'])) wui-flex {
      align-items: flex-end;
    }

    :host(:not([data-mobile-fullscreen='true'])) wui-card {
      max-width: 100%;
      border-bottom: none;
    }

    :host(:not([data-mobile-fullscreen='true'])) wui-card[data-embedded='true'] {
      border-bottom-left-radius: clamp(0px, var(--apkt-borderRadius-8), 44px);
      border-bottom-right-radius: clamp(0px, var(--apkt-borderRadius-8), 44px);
    }

    :host(:not([data-mobile-fullscreen='true'])) wui-card:not([data-embedded='true']) {
      border-bottom-left-radius: 0px;
      border-bottom-right-radius: 0px;
    }

    wui-card[shake='true'] {
      animation: w3m-shake 0.5s ${({easings:o})=>o['ease-out-power-2']};
    }
  }

  @keyframes fade-in {
    0% {
      transform: scale(0.99) translateY(4px);
    }
    100% {
      transform: scale(1) translateY(0);
    }
  }

  @keyframes w3m-shake {
    0% {
      transform: scale(1) rotate(0deg);
    }
    20% {
      transform: scale(1) rotate(-1deg);
    }
    40% {
      transform: scale(1) rotate(1.5deg);
    }
    60% {
      transform: scale(1) rotate(-1.5deg);
    }
    80% {
      transform: scale(1) rotate(1deg);
    }
    100% {
      transform: scale(1) rotate(0deg);
    }
  }

  @keyframes card-background-border {
    from {
      background-color: ${({tokens:o})=>o.theme.backgroundPrimary};
    }
    to {
      background-color: ${({tokens:o})=>o.theme.foregroundSecondary};
    }
  }

  @keyframes card-background-default {
    from {
      background-color: ${({tokens:o})=>o.theme.foregroundSecondary};
    }
    to {
      background-color: ${({tokens:o})=>o.theme.backgroundPrimary};
    }
  }
`},6267,[4650]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.W3mUsageExceededView=void 0;var i=_r(_d[1]),r=_r(_d[2]),n=_r(_d[3]);_r(_d[4]),_r(_d[5]),_r(_d[6]),_r(_d[7]);var o=t(_r(_d[8])),c=this&&this.__decorate||function(t,i,r,n){var o,c=arguments.length,l=c<3?i:null===n?n=Object.getOwnPropertyDescriptor(i,r):n;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)l=Reflect.decorate(t,i,r,n);else for(var u=t.length-1;u>=0;u--)(o=t[u])&&(l=(c<3?o(l):c>3?o(i,r,l):o(i,r))||l);return c>3&&l&&Object.defineProperty(i,r,l),l};let l=e.W3mUsageExceededView=class extends i.LitElement{constructor(){super()}render(){return i.html`
      <wui-flex
        flexDirection="column"
        alignItems="center"
        gap="4"
        .padding="${['1','3','4','3']}"
      >
        <wui-flex justifyContent="center" alignItems="center" class="icon-box">
          <wui-icon size="xxl" color="error" name="warningCircle"></wui-icon>
        </wui-flex>

        <wui-text variant="lg-medium" color="primary" align="center">
          The app isn't responding as expected
        </wui-text>
        <wui-text variant="md-regular" color="secondary" align="center">
          Try again or reach out to the app team for help.
        </wui-text>

        <wui-button
          variant="neutral-secondary"
          size="md"
          @click=${this.onTryAgainClick.bind(this)}
          data-testid="w3m-usage-exceeded-button"
        >
          <wui-icon color="inherit" slot="iconLeft" name="refresh"></wui-icon>
          Try Again
        </wui-button>
      </wui-flex>
    `}onTryAgainClick(){r.RouterController.goBack()}};l.styles=o.default,e.W3mUsageExceededView=l=c([(0,n.customElement)('w3m-usage-exceeded-view')],l)},6268,[2,4653,4632,4650,4738,4685,4743,4747,6269]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var o=r(d[0]);e.default=o.css`
  .icon-box {
    width: 64px;
    height: 64px;
    border-radius: ${({borderRadius:o})=>o[5]};
    background-color: ${({colors:o})=>o.semanticError010};
  }
`},6269,[4650]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.W3mListWallet=void 0;var s=_r(_d[1]),i=_r(_d[2]),r=_r(_d[3]),o=_r(_d[4]),n=_r(_d[5]);_r(_d[6]);var l=t(_r(_d[7])),p=this&&this.__decorate||function(t,s,i,r){var o,n=arguments.length,l=n<3?s:null===r?r=Object.getOwnPropertyDescriptor(s,i):r;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)l=Reflect.decorate(t,s,i,r);else for(var p=t.length-1;p>=0;p--)(o=t[p])&&(l=(n<3?o(l):n>3?o(s,i,l):o(s,i))||l);return n>3&&l&&Object.defineProperty(s,i,l),l};let d=e.W3mListWallet=class extends s.LitElement{constructor(){super(...arguments),this.hasImpressionSent=!1,this.walletImages=[],this.imageSrc='',this.name='',this.size='md',this.tabIdx=void 0,this.disabled=!1,this.showAllWallets=!1,this.loading=!1,this.loadingSpinnerColor='accent-100',this.rdnsId='',this.displayIndex=void 0,this.walletRank=void 0,this.namespaces=[]}connectedCallback(){super.connectedCallback()}disconnectedCallback(){super.disconnectedCallback(),this.cleanupIntersectionObserver()}updated(t){super.updated(t),(t.has('name')||t.has('imageSrc')||t.has('walletRank'))&&(this.hasImpressionSent=!1);t.has('walletRank')&&this.walletRank&&!this.intersectionObserver&&this.setupIntersectionObserver()}setupIntersectionObserver(){this.intersectionObserver=new IntersectionObserver(t=>{t.forEach(t=>{!t.isIntersecting||this.loading||this.hasImpressionSent||this.sendImpressionEvent()})},{threshold:.1}),this.intersectionObserver.observe(this)}cleanupIntersectionObserver(){this.intersectionObserver&&(this.intersectionObserver.disconnect(),this.intersectionObserver=void 0)}sendImpressionEvent(){this.name&&!this.hasImpressionSent&&this.walletRank&&(this.hasImpressionSent=!0,(this.rdnsId||this.name)&&o.EventsController.sendWalletImpressionEvent({name:this.name,walletRank:this.walletRank,rdnsId:this.rdnsId,view:o.RouterController.state.view,displayIndex:this.displayIndex}))}handleGetWalletNamespaces(){return Object.keys(o.AdapterController.state.adapters).length>1?this.namespaces:[]}render(){return s.html`
      <wui-list-wallet
        .walletImages=${this.walletImages}
        imageSrc=${(0,r.ifDefined)(this.imageSrc)}
        name=${this.name}
        size=${(0,r.ifDefined)(this.size)}
        tagLabel=${(0,r.ifDefined)(this.tagLabel)}
        .tagVariant=${this.tagVariant}
        .walletIcon=${this.walletIcon}
        .tabIdx=${this.tabIdx}
        .disabled=${this.disabled}
        .showAllWallets=${this.showAllWallets}
        .loading=${this.loading}
        loadingSpinnerColor=${this.loadingSpinnerColor}
        .namespaces=${this.handleGetWalletNamespaces()}
      ></wui-list-wallet>
    `}};d.styles=l.default,p([(0,i.property)({type:Array})],d.prototype,"walletImages",void 0),p([(0,i.property)()],d.prototype,"imageSrc",void 0),p([(0,i.property)()],d.prototype,"name",void 0),p([(0,i.property)()],d.prototype,"size",void 0),p([(0,i.property)()],d.prototype,"tagLabel",void 0),p([(0,i.property)()],d.prototype,"tagVariant",void 0),p([(0,i.property)()],d.prototype,"walletIcon",void 0),p([(0,i.property)()],d.prototype,"tabIdx",void 0),p([(0,i.property)({type:Boolean})],d.prototype,"disabled",void 0),p([(0,i.property)({type:Boolean})],d.prototype,"showAllWallets",void 0),p([(0,i.property)({type:Boolean})],d.prototype,"loading",void 0),p([(0,i.property)({type:String})],d.prototype,"loadingSpinnerColor",void 0),p([(0,i.property)()],d.prototype,"rdnsId",void 0),p([(0,i.property)()],d.prototype,"displayIndex",void 0),p([(0,i.property)()],d.prototype,"walletRank",void 0),p([(0,i.property)({type:Array})],d.prototype,"namespaces",void 0),e.W3mListWallet=d=p([(0,n.customElement)('w3m-list-wallet')],d)},6270,[2,4653,4674,4688,4632,4650,4690,6271]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var t=r(d[0]);e.default=t.css`
  :host {
    width: 100%;
  }
`},6271,[4650]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.W3mRouterContainer=void 0;var i=_r(_d[1]),r=_r(_d[2]),o=_r(_d[3]),s=_r(_d[4]),n=_r(_d[5]),h=t(_r(_d[6])),l=this&&this.__decorate||function(t,i,r,o){var s,n=arguments.length,h=n<3?i:null===o?o=Object.getOwnPropertyDescriptor(i,r):o;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)h=Reflect.decorate(t,i,r,o);else for(var l=t.length-1;l>=0;l--)(s=t[l])&&(h=(n<3?s(h):n>3?s(i,r,h):s(i,r))||h);return n>3&&h&&Object.defineProperty(i,r,h),h};let p=e.W3mRouterContainer=class extends i.LitElement{constructor(){super(...arguments),this.resizeObserver=void 0,this.transitionDuration='0.15s',this.transitionFunction='',this.history='',this.view='',this.setView=void 0,this.viewDirection='',this.historyState='',this.previousHeight='0px',this.mobileFullScreen=s.OptionsController.state.enableMobileFullScreen,this.onViewportResize=()=>{this.updateContainerHeight()}}updated(t){if(t.has('history')){const t=this.history;''!==this.historyState&&this.historyState!==t&&this.onViewChange(t)}t.has('transitionDuration')&&this.style.setProperty('--local-duration',this.transitionDuration),t.has('transitionFunction')&&this.style.setProperty('--local-transition',this.transitionFunction)}firstUpdated(){this.transitionFunction&&this.style.setProperty('--local-transition',this.transitionFunction),this.style.setProperty('--local-duration',this.transitionDuration),this.historyState=this.history,this.resizeObserver=new ResizeObserver(t=>{for(const i of t)if(i.target===this.getWrapper()){let t=i.contentRect.height;const r=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--apkt-footer-height')||'0');if(this.mobileFullScreen){t=(window.visualViewport?.height||window.innerHeight)-this.getHeaderHeight()-r,this.style.setProperty('--local-border-bottom-radius','0px')}else{t=t+r,this.style.setProperty('--local-border-bottom-radius',r?'var(--apkt-borderRadius-5)':'0px')}this.style.setProperty('--local-container-height',`${t}px`),'0px'!==this.previousHeight&&this.style.setProperty('--local-duration-height',this.transitionDuration),this.previousHeight=`${t}px`}}),this.resizeObserver.observe(this.getWrapper()),this.updateContainerHeight(),window.addEventListener('resize',this.onViewportResize),window.visualViewport?.addEventListener('resize',this.onViewportResize)}disconnectedCallback(){const t=this.getWrapper();t&&this.resizeObserver&&this.resizeObserver.unobserve(t),window.removeEventListener('resize',this.onViewportResize),window.visualViewport?.removeEventListener('resize',this.onViewportResize)}render(){return i.html`
      <div class="container" data-mobile-fullscreen="${(0,o.ifDefined)(this.mobileFullScreen)}">
        <div
          class="page"
          data-mobile-fullscreen="${(0,o.ifDefined)(this.mobileFullScreen)}"
          view-direction="${this.viewDirection}"
        >
          <div class="page-content">
            <slot></slot>
          </div>
        </div>
      </div>
    `}onViewChange(t){const i=t.split(',').filter(Boolean),r=this.historyState.split(',').filter(Boolean),o=r.length,s=i.length,h=i[i.length-1]||'',l=n.UiHelperUtil.cssDurationToNumber(this.transitionDuration);let p='';s>o?p='next':s<o?p='prev':s===o&&i[s-1]!==r[o-1]&&(p='next'),this.viewDirection=`${p}-${h}`,setTimeout(()=>{this.historyState=t,this.setView?.(h)},l),setTimeout(()=>{this.viewDirection=''},2*l)}getWrapper(){return this.shadowRoot?.querySelector('div.page')}updateContainerHeight(){const t=this.getWrapper();if(!t)return;const i=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--apkt-footer-height')||'0');let r=0;if(this.mobileFullScreen){r=(window.visualViewport?.height||window.innerHeight)-this.getHeaderHeight()-i,this.style.setProperty('--local-border-bottom-radius','0px')}else r=t.getBoundingClientRect().height+i,this.style.setProperty('--local-border-bottom-radius',i?'var(--apkt-borderRadius-5)':'0px');this.style.setProperty('--local-container-height',`${r}px`),'0px'!==this.previousHeight&&this.style.setProperty('--local-duration-height',this.transitionDuration),this.previousHeight=`${r}px`}getHeaderHeight(){return 60}};p.styles=[h.default],l([(0,r.property)({type:String})],p.prototype,"transitionDuration",void 0),l([(0,r.property)({type:String})],p.prototype,"transitionFunction",void 0),l([(0,r.property)({type:String})],p.prototype,"history",void 0),l([(0,r.property)({type:String})],p.prototype,"view",void 0),l([(0,r.property)({attribute:!1})],p.prototype,"setView",void 0),l([(0,r.state)()],p.prototype,"viewDirection",void 0),l([(0,r.state)()],p.prototype,"historyState",void 0),l([(0,r.state)()],p.prototype,"previousHeight",void 0),l([(0,r.state)()],p.prototype,"mobileFullScreen",void 0),e.W3mRouterContainer=p=l([(0,n.customElement)('w3m-router-container')],p)},6272,[2,4653,4674,4688,4632,4650,6273]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var t=r(d[0]);e.default=t.css`
  :host {
    --local-duration-height: 0s;
    --local-duration: ${({durations:t})=>t.lg};
    --local-transition: ${({easings:t})=>t['ease-out-power-2']};
  }

  .container {
    display: block;
    overflow: hidden;
    overflow: hidden;
    position: relative;
    height: var(--local-container-height);
    transition: height var(--local-duration-height) var(--local-transition);
    will-change: height, padding-bottom;
  }

  .container[data-mobile-fullscreen='true'] {
    overflow: scroll;
  }

  .page {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    width: 100%;
    height: auto;
    width: inherit;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    background-color: ${({tokens:t})=>t.theme.backgroundPrimary};
    border-bottom-left-radius: var(--local-border-bottom-radius);
    border-bottom-right-radius: var(--local-border-bottom-radius);
    transition: border-bottom-left-radius var(--local-duration) var(--local-transition);
  }

  .page[data-mobile-fullscreen='true'] {
    height: 100%;
  }

  .page-content {
    display: flex;
    flex-direction: column;
    min-height: 100%;
  }

  .footer {
    height: var(--apkt-footer-height);
  }

  div.page[view-direction^='prev-'] .page-content {
    animation:
      slide-left-out var(--local-duration) forwards var(--local-transition),
      slide-left-in var(--local-duration) forwards var(--local-transition);
    animation-delay: 0ms, var(--local-duration, ${({durations:t})=>t.lg});
  }

  div.page[view-direction^='next-'] .page-content {
    animation:
      slide-right-out var(--local-duration) forwards var(--local-transition),
      slide-right-in var(--local-duration) forwards var(--local-transition);
    animation-delay: 0ms, var(--local-duration, ${({durations:t})=>t.lg});
  }

  @keyframes slide-left-out {
    from {
      transform: translateX(0px) scale(1);
      opacity: 1;
      filter: blur(0px);
    }
    to {
      transform: translateX(8px) scale(0.99);
      opacity: 0;
      filter: blur(4px);
    }
  }

  @keyframes slide-left-in {
    from {
      transform: translateX(-8px) scale(0.99);
      opacity: 0;
      filter: blur(4px);
    }
    to {
      transform: translateX(0) translateY(0) scale(1);
      opacity: 1;
      filter: blur(0px);
    }
  }

  @keyframes slide-right-out {
    from {
      transform: translateX(0px) scale(1);
      opacity: 1;
      filter: blur(0px);
    }
    to {
      transform: translateX(-8px) scale(0.99);
      opacity: 0;
      filter: blur(4px);
    }
  }

  @keyframes slide-right-in {
    from {
      transform: translateX(8px) scale(0.99);
      opacity: 0;
      filter: blur(4px);
    }
    to {
      transform: translateX(0) translateY(0) scale(1);
      opacity: 1;
      filter: blur(0px);
    }
  }
`},6273,[4650]);