__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0});var n=r(d[0]);Object.keys(n).forEach(function(t){"default"!==t&&"__esModule"!==t&&(t in e&&e[t]===n[t]||Object.defineProperty(e,t,{enumerable:!0,get:function(){return n[t]}}))})},6902,[7030]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.W3mModalBase=e.W3mModal=e.AppKitModal=void 0;var o=_r(_d[1]),r=_r(_d[2]),s=_r(_d[3]),i=_r(_d[4]),l=_r(_d[5]),n=_r(_d[6]);_r(_d[7]),_r(_d[8]),_r(_d[9]),_r(_d[10]),_r(_d[11]),_r(_d[12]),_r(_d[13]);var d=t(_r(_d[14])),c=this&&this.__decorate||function(t,o,r,s){var i,l=arguments.length,n=l<3?o:null===s?s=Object.getOwnPropertyDescriptor(o,r):s;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)n=Reflect.decorate(t,o,r,s);else for(var d=t.length-1;d>=0;d--)(i=t[d])&&(n=(l<3?i(n):l>3?i(o,r,n):i(o,r))||n);return l>3&&n&&Object.defineProperty(o,r,n),n};const h='scroll-lock';class p extends o.LitElement{constructor(){super(),this.unsubscribe=[],this.abortController=void 0,this.hasPrefetched=!1,this.enableEmbedded=l.OptionsController.state.enableEmbedded,this.open=l.ModalController.state.open,this.caipAddress=l.ChainController.state.activeCaipAddress,this.caipNetwork=l.ChainController.state.activeCaipNetwork,this.shake=l.ModalController.state.shake,this.filterByNamespace=l.ConnectorController.state.filterByNamespace,this.initializeTheming(),l.ApiController.prefetchAnalyticsConfig(),this.unsubscribe.push(l.ModalController.subscribeKey('open',t=>t?this.onOpen():this.onClose()),l.ModalController.subscribeKey('shake',t=>this.shake=t),l.ChainController.subscribeKey('activeCaipNetwork',t=>this.onNewNetwork(t)),l.ChainController.subscribeKey('activeCaipAddress',t=>this.onNewAddress(t)),l.OptionsController.subscribeKey('enableEmbedded',t=>this.enableEmbedded=t),l.ConnectorController.subscribeKey('filterByNamespace',t=>{this.filterByNamespace===t||l.ChainController.getAccountData(t)?.caipAddress||(l.ApiController.fetchRecommendedWallets(),this.filterByNamespace=t)}))}firstUpdated(){if(this.caipAddress){if(this.enableEmbedded)return l.ModalController.close(),void this.prefetch();this.onNewAddress(this.caipAddress)}this.open&&this.onOpen(),this.enableEmbedded&&this.prefetch()}disconnectedCallback(){this.unsubscribe.forEach(t=>t()),this.onRemoveKeyboardListener()}render(){return this.style.cssText=`\n      --local-border-bottom-mobile-radius: ${this.enableEmbedded?'clamp(0px, var(--wui-border-radius-l), 44px)':'0px'};\n    `,this.enableEmbedded?o.html`${this.contentTemplate()}
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
      <w3m-snackbar></w3m-snackbar>
      <w3m-alertbar></w3m-alertbar>
    </wui-card>`}async onOverlayClick(t){t.target===t.currentTarget&&await this.handleClose()}async handleClose(){await l.ModalUtil.safeClose()}initializeTheming(){const{themeVariables:t,themeMode:o}=l.ThemeController.state,r=n.UiHelperUtil.getColorTheme(o);(0,n.initializeTheming)(t,r)}onClose(){this.open=!1,this.classList.remove('open'),this.onScrollUnlock(),l.SnackController.hide(),this.onRemoveKeyboardListener()}onOpen(){this.open=!0,this.classList.add('open'),this.onScrollLock(),this.onAddKeyboardListener()}onScrollLock(){const t=document.createElement('style');t.dataset.w3m=h,t.textContent="\n      body {\n        touch-action: none;\n        overflow: hidden;\n        overscroll-behavior: contain;\n      }\n      w3m-modal {\n        pointer-events: auto;\n      }\n    ",document.head.appendChild(t)}onScrollUnlock(){const t=document.head.querySelector(`style[data-w3m="${h}"]`);t&&t.remove()}onAddKeyboardListener(){this.abortController=new AbortController;const t=this.shadowRoot?.querySelector('wui-card');t?.focus(),window.addEventListener('keydown',o=>{if('Escape'===o.key)this.handleClose();else if('Tab'===o.key){const{tagName:r}=o.target;!r||r.includes('W3M-')||r.includes('WUI-')||t?.focus()}},this.abortController)}onRemoveKeyboardListener(){this.abortController?.abort(),this.abortController=void 0}async onNewAddress(t){const o=l.ChainController.state.isSwitchingNamespace,r=l.CoreHelperUtil.getPlainAddress(t),s=o&&r;!r&&!o?l.ModalController.close():s&&l.RouterController.goBack(),await l.SIWXUtil.initializeIfEnabled(),this.caipAddress=t,l.ChainController.setIsSwitchingNamespace(!1)}onNewNetwork(t){const o=this.caipNetwork,r=o?.caipNetworkId?.toString(),s=o?.chainNamespace,n=t?.caipNetworkId?.toString(),d=t?.chainNamespace,c=r!==n,h=c&&!(s!==d),p=o?.name===i.ConstantsUtil.UNSUPPORTED_NETWORK_NAME,b='ConnectingExternal'===l.RouterController.state.view,C=!l.ChainController.getAccountData(t?.chainNamespace)?.caipAddress,u='UnsupportedChain'===l.RouterController.state.view;let w=!1;l.ModalController.state.open&&!b&&(C?c&&(w=!0):(u||h&&!p)&&(w=!0)),w&&'SIWXSignMessage'!==l.RouterController.state.view&&l.RouterController.goBack(),this.caipNetwork=t}prefetch(){this.hasPrefetched||(l.ApiController.prefetch(),l.ApiController.fetchWalletsByPage({page:1}),this.hasPrefetched=!0)}}e.W3mModalBase=p,p.styles=d.default,c([(0,r.property)({type:Boolean})],p.prototype,"enableEmbedded",void 0),c([(0,r.state)()],p.prototype,"open",void 0),c([(0,r.state)()],p.prototype,"caipAddress",void 0),c([(0,r.state)()],p.prototype,"caipNetwork",void 0),c([(0,r.state)()],p.prototype,"shake",void 0),c([(0,r.state)()],p.prototype,"filterByNamespace",void 0);let b=e.W3mModal=class extends p{};e.W3mModal=b=c([(0,n.customElement)('w3m-modal')],b);let C=e.AppKitModal=class extends p{};e.AppKitModal=C=c([(0,n.customElement)('appkit-modal')],C)},7030,[2,4949,4958,4972,4608,4629,4946,7031,4969,7034,7039,7048,7053,7055,7057]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0});var n=r(d[0]);Object.keys(n).forEach(function(t){"default"!==t&&"__esModule"!==t&&(t in e&&e[t]===n[t]||Object.defineProperty(e,t,{enumerable:!0,get:function(){return n[t]}}))})},7031,[7032]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.WuiCard=void 0;var r=_r(_d[1]),l=_r(_d[2]),o=_r(_d[3]),n=t(_r(_d[4])),c=this&&this.__decorate||function(t,r,l,o){var n,c=arguments.length,d=c<3?r:null===o?o=Object.getOwnPropertyDescriptor(r,l):o;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)d=Reflect.decorate(t,r,l,o);else for(var i=t.length-1;i>=0;i--)(n=t[i])&&(d=(c<3?n(d):c>3?n(r,l,d):n(r,l))||d);return c>3&&d&&Object.defineProperty(r,l,d),d};let d=e.WuiCard=class extends r.LitElement{render(){return r.html`<slot></slot>`}};d.styles=[l.resetStyles,n.default],e.WuiCard=d=c([(0,o.customElement)('wui-card')],d)},7032,[2,4949,4948,4957,7033]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var o=r(d[0]);e.default=o.css`
  :host {
    display: block;
    border-radius: clamp(0px, var(--wui-border-radius-l), 44px);
    box-shadow: 0 0 0 1px var(--wui-color-gray-glass-005);
    background-color: var(--wui-color-modal-bg);
    overflow: hidden;
  }

  :host([data-embedded='true']) {
    box-shadow:
      0 0 0 1px var(--wui-color-gray-glass-005),
      0px 4px 12px 4px var(--w3m-card-embedded-shadow-color);
  }
`},7033,[4949]);
__d(function(g,_r,_i,a,m,e,_d){var r=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.presets=e.W3mAlertBar=void 0;var o=_r(_d[1]),t=_r(_d[2]),n=_r(_d[3]),s=_r(_d[4]);_r(_d[5]);var i=r(_r(_d[6])),c=this&&this.__decorate||function(r,o,t,n){var s,i=arguments.length,c=i<3?o:null===n?n=Object.getOwnPropertyDescriptor(o,t):n;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)c=Reflect.decorate(r,o,t,n);else for(var l=r.length-1;l>=0;l--)(s=r[l])&&(c=(i<3?s(c):i>3?s(o,t,c):s(o,t))||c);return i>3&&c&&Object.defineProperty(o,t,c),c};const l=e.presets={info:{backgroundColor:'fg-350',iconColor:'fg-325',icon:'info'},success:{backgroundColor:'success-glass-reown-020',iconColor:'success-125',icon:'checkmark'},warning:{backgroundColor:'warning-glass-reown-020',iconColor:'warning-100',icon:'warningCircle'},error:{backgroundColor:'error-glass-reown-020',iconColor:'error-125',icon:'exclamationTriangle'}};let u=e.W3mAlertBar=class extends o.LitElement{constructor(){super(),this.unsubscribe=[],this.open=n.AlertController.state.open,this.onOpen(!0),this.unsubscribe.push(n.AlertController.subscribeKey('open',r=>{this.open=r,this.onOpen(!1)}))}disconnectedCallback(){this.unsubscribe.forEach(r=>r())}render(){const{message:r,variant:t}=n.AlertController.state,s=l[t];return o.html`
      <wui-alertbar
        message=${r}
        backgroundColor=${s?.backgroundColor}
        iconColor=${s?.iconColor}
        icon=${s?.icon}
      ></wui-alertbar>
    `}onOpen(r){this.open?(this.animate([{opacity:0,transform:'scale(0.85)'},{opacity:1,transform:'scale(1)'}],{duration:150,fill:'forwards',easing:'ease'}),this.style.cssText="pointer-events: auto"):r||(this.animate([{opacity:1,transform:'scale(1)'},{opacity:0,transform:'scale(0.85)'}],{duration:150,fill:'forwards',easing:'ease'}),this.style.cssText="pointer-events: none")}};u.styles=i.default,c([(0,t.state)()],u.prototype,"open",void 0),e.W3mAlertBar=u=c([(0,s.customElement)('w3m-alertbar')],u)},7034,[2,4949,4958,4629,4946,7035,7038]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0});var n=r(d[0]);Object.keys(n).forEach(function(t){"default"!==t&&"__esModule"!==t&&(t in e&&e[t]===n[t]||Object.defineProperty(e,t,{enumerable:!0,get:function(){return n[t]}}))})},7035,[7036]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.WuiAlertBar=void 0;var o=_r(_d[1]),r=_r(_d[2]),i=_r(_d[3]);_r(_d[4]),_r(_d[5]),_r(_d[6]);var l=_r(_d[7]),n=_r(_d[8]),c=t(_r(_d[9])),s=this&&this.__decorate||function(t,o,r,i){var l,n=arguments.length,c=n<3?o:null===i?i=Object.getOwnPropertyDescriptor(o,r):i;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)c=Reflect.decorate(t,o,r,i);else for(var s=t.length-1;s>=0;s--)(l=t[s])&&(c=(n<3?l(c):n>3?l(o,r,c):l(o,r))||c);return n>3&&c&&Object.defineProperty(o,r,c),c};let u=e.WuiAlertBar=class extends o.LitElement{constructor(){super(...arguments),this.message='',this.backgroundColor='accent-100',this.iconColor='accent-100',this.icon='info'}render(){return this.style.cssText=`\n      --local-icon-bg-value: var(--wui-color-${this.backgroundColor});\n   `,o.html`
      <wui-flex flexDirection="row" justifyContent="space-between" alignItems="center">
        <wui-flex columnGap="xs" flexDirection="row" alignItems="center">
          <wui-flex
            flexDirection="row"
            alignItems="center"
            justifyContent="center"
            class="icon-box"
          >
            <wui-icon color=${this.iconColor} size="md" name=${this.icon}></wui-icon>
          </wui-flex>
          <wui-text variant="small-500" color="bg-350" data-testid="wui-alertbar-text"
            >${this.message}</wui-text
          >
        </wui-flex>
        <wui-icon
          class="close"
          color="bg-350"
          size="sm"
          name="close"
          @click=${this.onClose}
        ></wui-icon>
      </wui-flex>
    `}onClose(){i.AlertController.close()}};u.styles=[l.resetStyles,c.default],s([(0,r.property)()],u.prototype,"message",void 0),s([(0,r.property)()],u.prototype,"backgroundColor",void 0),s([(0,r.property)()],u.prototype,"iconColor",void 0),s([(0,r.property)()],u.prototype,"icon",void 0),e.WuiAlertBar=u=s([(0,n.customElement)('wui-alertbar')],u)},7036,[2,4949,4958,4629,4974,4983,4970,4948,4957,7037]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var o=r(d[0]);e.default=o.css`
  :host {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--wui-spacing-s);
    border-radius: var(--wui-border-radius-s);
    border: 1px solid var(--wui-color-dark-glass-100);
    box-sizing: border-box;
    background-color: var(--wui-color-bg-325);
    box-shadow: 0px 0px 16px 0px rgba(0, 0, 0, 0.25);
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
  }

  .icon-box {
    height: 40px;
    width: 40px;
    border-radius: var(--wui-border-radius-3xs);
    background-color: var(--local-icon-bg-value);
  }
`},7037,[4949]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var t=r(d[0]);e.default=t.css`
  :host {
    display: block;
    position: absolute;
    top: var(--wui-spacing-s);
    left: var(--wui-spacing-l);
    right: var(--wui-spacing-l);
    opacity: 0;
    pointer-events: none;
  }
`},7038,[4949]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.W3mHeader=void 0;var i=_r(_d[1]),o=_r(_d[2]),n=_r(_d[3]),r=_r(_d[4]),s=_r(_d[5]);_r(_d[6]),_r(_d[7]),_r(_d[8]),_r(_d[9]),_r(_d[10]);var l=_r(_d[11]),c=t(_r(_d[12])),h=this&&this.__decorate||function(t,i,o,n){var r,s=arguments.length,l=s<3?i:null===n?n=Object.getOwnPropertyDescriptor(i,o):n;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)l=Reflect.decorate(t,i,o,n);else for(var c=t.length-1;c>=0;c--)(r=t[c])&&(l=(s<3?r(l):s>3?r(i,o,l):r(i,o))||l);return s>3&&l&&Object.defineProperty(i,o,l),l};const d=['SmartSessionList'];function w(){const t=r.RouterController.state.data?.connector?.name,i=r.RouterController.state.data?.wallet?.name,o=r.RouterController.state.data?.network?.name,n=i??t,s=r.ConnectorController.getConnectors();return{Connect:`Connect ${1===s.length&&'w3m-email'===s[0]?.id?'Email':''} Wallet`,Create:'Create Wallet',ChooseAccountName:void 0,Account:void 0,AccountSettings:void 0,AllWallets:'All Wallets',ApproveTransaction:'Approve Transaction',BuyInProgress:'Buy',ConnectingExternal:n??'Connect Wallet',ConnectingWalletConnect:n??'WalletConnect',ConnectingWalletConnectBasic:'WalletConnect',ConnectingSiwe:'Sign In',Convert:'Convert',ConvertSelectToken:'Select token',ConvertPreview:'Preview convert',Downloads:n?`Get ${n}`:'Downloads',EmailLogin:'Email Login',EmailVerifyOtp:'Confirm Email',EmailVerifyDevice:'Register Device',GetWallet:'Get a wallet',Networks:'Choose Network',OnRampProviders:'Choose Provider',OnRampActivity:'Activity',OnRampTokenSelect:'Select Token',OnRampFiatSelect:'Select Currency',Pay:'How you pay',Profile:void 0,SwitchNetwork:o??'Switch Network',SwitchAddress:'Switch Address',Transactions:'Activity',UnsupportedChain:'Switch Network',UpgradeEmailWallet:'Upgrade your Wallet',UpdateEmailWallet:'Edit Email',UpdateEmailPrimaryOtp:'Confirm Current Email',UpdateEmailSecondaryOtp:'Confirm New Email',WhatIsABuy:'What is Buy?',RegisterAccountName:'Choose name',RegisterAccountNameSuccess:'',WalletReceive:'Receive',WalletCompatibleNetworks:'Compatible Networks',Swap:'Swap',SwapSelectToken:'Select token',SwapPreview:'Preview swap',WalletSend:'Send',WalletSendPreview:'Review send',WalletSendSelectToken:'Select Token',WhatIsANetwork:'What is a network?',WhatIsAWallet:'What is a wallet?',ConnectWallets:'Connect wallet',ConnectSocials:'All socials',ConnectingSocial:r.AccountController.state.socialProvider?r.AccountController.state.socialProvider:'Connect Social',ConnectingMultiChain:'Select chain',ConnectingFarcaster:'Farcaster',SwitchActiveChain:'Switch chain',SmartSessionCreated:void 0,SmartSessionList:'Smart Sessions',SIWXSignMessage:'Sign In',PayLoading:'Payment in progress'}}let u=e.W3mHeader=class extends i.LitElement{constructor(){super(),this.unsubscribe=[],this.heading=w()[r.RouterController.state.view],this.network=r.ChainController.state.activeCaipNetwork,this.networkImage=r.AssetUtil.getNetworkImage(this.network),this.showBack=!1,this.prevHistoryLength=1,this.view=r.RouterController.state.view,this.viewDirection='',this.headerText=w()[r.RouterController.state.view],this.unsubscribe.push(r.AssetController.subscribeNetworkImages(()=>{this.networkImage=r.AssetUtil.getNetworkImage(this.network)}),r.RouterController.subscribeKey('view',t=>{setTimeout(()=>{this.view=t,this.headerText=w()[t]},l.ConstantsUtil.ANIMATION_DURATIONS.HeaderText),this.onViewChange(),this.onHistoryChange()}),r.ChainController.subscribeKey('activeCaipNetwork',t=>{this.network=t,this.networkImage=r.AssetUtil.getNetworkImage(this.network)}))}disconnectCallback(){this.unsubscribe.forEach(t=>t())}render(){return i.html`
      <wui-flex .padding=${this.getPadding()} justifyContent="space-between" alignItems="center">
        ${this.leftHeaderTemplate()} ${this.titleTemplate()} ${this.rightHeaderTemplate()}
      </wui-flex>
    `}onWalletHelp(){r.EventsController.sendEvent({type:'track',event:'CLICK_WALLET_HELP'}),r.RouterController.push('WhatIsAWallet')}async onClose(){await r.ModalUtil.safeClose()}rightHeaderTemplate(){const t=r.OptionsController?.state?.features?.smartSessions;return'Account'===r.RouterController.state.view&&t?i.html`<wui-flex>
      <wui-icon-link
        icon="clock"
        @click=${()=>r.RouterController.push('SmartSessionList')}
        data-testid="w3m-header-smart-sessions"
      ></wui-icon-link>
      ${this.closeButtonTemplate()}
    </wui-flex> `:this.closeButtonTemplate()}closeButtonTemplate(){return i.html`
      <wui-icon-link
        icon="close"
        @click=${this.onClose.bind(this)}
        data-testid="w3m-header-close"
      ></wui-icon-link>
    `}titleTemplate(){const t=d.includes(this.view);return i.html`
      <wui-flex
        view-direction="${this.viewDirection}"
        class="w3m-header-title"
        alignItems="center"
        gap="xs"
      >
        <wui-text variant="paragraph-700" color="fg-100" data-testid="w3m-header-text"
          >${this.headerText}</wui-text
        >
        ${t?i.html`<wui-tag variant="main">Beta</wui-tag>`:null}
      </wui-flex>
    `}leftHeaderTemplate(){const{view:t}=r.RouterController.state,o='Connect'===t,s=r.OptionsController.state.enableEmbedded,l='ApproveTransaction'===t,c='ConnectingSiwe'===t,h='Account'===t,d=r.OptionsController.state.enableNetworkSwitch,w=l||c||o&&s;return h&&d?i.html`<wui-select
        id="dynamic"
        data-testid="w3m-account-select-network"
        active-network=${(0,n.ifDefined)(this.network?.name)}
        @click=${this.onNetworks.bind(this)}
        imageSrc=${(0,n.ifDefined)(this.networkImage)}
      ></wui-select>`:this.showBack&&!w?i.html`<wui-icon-link
        data-testid="header-back"
        id="dynamic"
        icon="chevronLeft"
        @click=${this.onGoBack.bind(this)}
      ></wui-icon-link>`:i.html`<wui-icon-link
      data-hidden=${!o}
      id="dynamic"
      icon="helpCircle"
      @click=${this.onWalletHelp.bind(this)}
    ></wui-icon-link>`}onNetworks(){this.isAllowedNetworkSwitch()&&(r.EventsController.sendEvent({type:'track',event:'CLICK_NETWORKS'}),r.RouterController.push('Networks'))}isAllowedNetworkSwitch(){const t=r.ChainController.getAllRequestedCaipNetworks(),i=!!t&&t.length>1,o=t?.find(({id:t})=>t===this.network?.id);return i||!o}getPadding(){return this.heading?['l','2l','l','2l']:['0','2l','0','2l']}onViewChange(){const{history:t}=r.RouterController.state;let i=l.ConstantsUtil.VIEW_DIRECTION.Next;t.length<this.prevHistoryLength&&(i=l.ConstantsUtil.VIEW_DIRECTION.Prev),this.prevHistoryLength=t.length,this.viewDirection=i}async onHistoryChange(){const{history:t}=r.RouterController.state,i=this.shadowRoot?.querySelector('#dynamic');t.length>1&&!this.showBack&&i?(await i.animate([{opacity:1},{opacity:0}],{duration:200,fill:'forwards',easing:'ease'}).finished,this.showBack=!0,i.animate([{opacity:0},{opacity:1}],{duration:200,fill:'forwards',easing:'ease'})):t.length<=1&&this.showBack&&i&&(await i.animate([{opacity:1},{opacity:0}],{duration:200,fill:'forwards',easing:'ease'}).finished,this.showBack=!1,i.animate([{opacity:0},{opacity:1}],{duration:200,fill:'forwards',easing:'ease'}))}onGoBack(){r.RouterController.goBack()}};u.styles=c.default,h([(0,o.state)()],u.prototype,"heading",void 0),h([(0,o.state)()],u.prototype,"network",void 0),h([(0,o.state)()],u.prototype,"networkImage",void 0),h([(0,o.state)()],u.prototype,"showBack",void 0),h([(0,o.state)()],u.prototype,"prevHistoryLength",void 0),h([(0,o.state)()],u.prototype,"view",void 0),h([(0,o.state)()],u.prototype,"viewDirection",void 0),h([(0,o.state)()],u.prototype,"headerText",void 0),e.W3mHeader=u=h([(0,s.customElement)('w3m-header')],u)},7039,[2,4949,4958,4972,4629,4946,4969,7040,7043,7046,4996,4945,7047]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0});var n=r(d[0]);Object.keys(n).forEach(function(t){"default"!==t&&"__esModule"!==t&&(t in e&&e[t]===n[t]||Object.defineProperty(e,t,{enumerable:!0,get:function(){return n[t]}}))})},7040,[7041]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.WuiIconLink=void 0;var o=_r(_d[1]),i=_r(_d[2]);_r(_d[3]);var r=_r(_d[4]),s=_r(_d[5]),n=t(_r(_d[6])),c=this&&this.__decorate||function(t,o,i,r){var s,n=arguments.length,c=n<3?o:null===r?r=Object.getOwnPropertyDescriptor(o,i):r;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)c=Reflect.decorate(t,o,i,r);else for(var l=t.length-1;l>=0;l--)(s=t[l])&&(c=(n<3?s(c):n>3?s(o,i,c):s(o,i))||c);return n>3&&c&&Object.defineProperty(o,i,c),c};let l=e.WuiIconLink=class extends o.LitElement{constructor(){super(...arguments),this.size='md',this.disabled=!1,this.icon='copy',this.iconColor='inherit'}render(){const t='lg'===this.size?'--wui-border-radius-xs':'--wui-border-radius-xxs',i='lg'===this.size?'--wui-spacing-1xs':'--wui-spacing-2xs';return this.style.cssText=`\n    --local-border-radius: var(${t});\n    --local-padding: var(${i});\n`,o.html`
      <button ?disabled=${this.disabled}>
        <wui-icon color=${this.iconColor} size=${this.size} name=${this.icon}></wui-icon>
      </button>
    `}};l.styles=[r.resetStyles,r.elementStyles,r.colorStyles,n.default],c([(0,i.property)()],l.prototype,"size",void 0),c([(0,i.property)({type:Boolean})],l.prototype,"disabled",void 0),c([(0,i.property)()],l.prototype,"icon",void 0),c([(0,i.property)()],l.prototype,"iconColor",void 0),e.WuiIconLink=l=c([(0,s.customElement)('wui-icon-link')],l)},7041,[2,4949,4958,4974,4948,4957,7042]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var o=r(d[0]);e.default=o.css`
  button {
    border-radius: var(--local-border-radius);
    color: var(--wui-color-fg-100);
    padding: var(--local-padding);
  }

  @media (max-width: 700px) {
    button {
      padding: var(--wui-spacing-s);
    }
  }

  button > wui-icon {
    pointer-events: none;
  }

  button:disabled > wui-icon {
    color: var(--wui-color-bg-300) !important;
  }

  button:disabled {
    background-color: transparent;
  }
`},7042,[4949]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0});var n=r(d[0]);Object.keys(n).forEach(function(t){"default"!==t&&"__esModule"!==t&&(t in e&&e[t]===n[t]||Object.defineProperty(e,t,{enumerable:!0,get:function(){return n[t]}}))})},7043,[7044]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.WuiSelect=void 0;var o=_r(_d[1]),r=_r(_d[2]);_r(_d[3]),_r(_d[4]),_r(_d[5]);var i=_r(_d[6]),c=_r(_d[7]),l=t(_r(_d[8])),n=this&&this.__decorate||function(t,o,r,i){var c,l=arguments.length,n=l<3?o:null===i?i=Object.getOwnPropertyDescriptor(o,r):i;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)n=Reflect.decorate(t,o,r,i);else for(var s=t.length-1;s>=0;s--)(c=t[s])&&(n=(l<3?c(n):l>3?c(o,r,n):c(o,r))||n);return l>3&&n&&Object.defineProperty(o,r,n),n};let s=e.WuiSelect=class extends o.LitElement{constructor(){super(...arguments),this.imageSrc=''}render(){return o.html`<button>
      ${this.imageTemplate()}
      <wui-icon size="xs" color="fg-200" name="chevronBottom"></wui-icon>
    </button>`}imageTemplate(){return this.imageSrc?o.html`<wui-image src=${this.imageSrc} alt="select visual"></wui-image>`:o.html`<wui-icon-box
      size="xxs"
      iconColor="fg-200"
      backgroundColor="fg-100"
      background="opaque"
      icon="networkPlaceholder"
    ></wui-icon-box>`}};s.styles=[i.resetStyles,i.elementStyles,i.colorStyles,l.default],n([(0,r.property)()],s.prototype,"imageSrc",void 0),e.WuiSelect=s=n([(0,c.customElement)('wui-select')],s)},7044,[2,4949,4958,4974,4989,4987,4948,4957,7045]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var o=r(d[0]);e.default=o.css`
  button {
    display: block;
    display: flex;
    align-items: center;
    padding: var(--wui-spacing-xxs);
    gap: var(--wui-spacing-xxs);
    transition: all var(--wui-ease-out-power-1) var(--wui-duration-md);
    border-radius: var(--wui-border-radius-xxs);
  }

  wui-image {
    border-radius: 100%;
    width: var(--wui-spacing-xl);
    height: var(--wui-spacing-xl);
  }

  wui-icon-box {
    width: var(--wui-spacing-xl);
    height: var(--wui-spacing-xl);
  }

  button:hover {
    background-color: var(--wui-color-gray-glass-002);
  }

  button:active {
    background-color: var(--wui-color-gray-glass-005);
  }
`},7045,[4949]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0});var n=r(d[0]);Object.keys(n).forEach(function(t){"default"!==t&&"__esModule"!==t&&(t in e&&e[t]===n[t]||Object.defineProperty(e,t,{enumerable:!0,get:function(){return n[t]}}))})},7046,[4991]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var t=r(d[0]);e.default=t.css`
  :host {
    height: 64px;
  }

  wui-text {
    text-transform: capitalize;
  }

  wui-flex.w3m-header-title {
    transform: translateY(0);
    opacity: 1;
  }

  wui-flex.w3m-header-title[view-direction='prev'] {
    animation:
      slide-down-out 120ms forwards var(--wui-ease-out-power-2),
      slide-down-in 120ms forwards var(--wui-ease-out-power-2);
    animation-delay: 0ms, 200ms;
  }

  wui-flex.w3m-header-title[view-direction='next'] {
    animation:
      slide-up-out 120ms forwards var(--wui-ease-out-power-2),
      slide-up-in 120ms forwards var(--wui-ease-out-power-2);
    animation-delay: 0ms, 200ms;
  }

  wui-icon-link[data-hidden='true'] {
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
`},7047,[4949]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.W3mSnackBar=void 0;var o=_r(_d[1]),r=_r(_d[2]),n=_r(_d[3]),s=_r(_d[4]);_r(_d[5]);var c=t(_r(_d[6])),i=this&&this.__decorate||function(t,o,r,n){var s,c=arguments.length,i=c<3?o:null===n?n=Object.getOwnPropertyDescriptor(o,r):n;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)i=Reflect.decorate(t,o,r,n);else for(var l=t.length-1;l>=0;l--)(s=t[l])&&(i=(c<3?s(i):c>3?s(o,r,i):s(o,r))||i);return c>3&&i&&Object.defineProperty(o,r,i),i};const l={loading:void 0,success:{backgroundColor:'success-100',iconColor:'success-100',icon:'checkmark'},error:{backgroundColor:'error-100',iconColor:'error-100',icon:'close'}};let u=e.W3mSnackBar=class extends o.LitElement{constructor(){super(),this.unsubscribe=[],this.timeout=void 0,this.open=n.SnackController.state.open,this.unsubscribe.push(n.SnackController.subscribeKey('open',t=>{this.open=t,this.onOpen()}))}disconnectedCallback(){clearTimeout(this.timeout),this.unsubscribe.forEach(t=>t())}render(){const{message:t,variant:r,svg:s}=n.SnackController.state,c=l[r],{icon:i,iconColor:u}=s??c??{};return o.html`
      <wui-snackbar
        message=${t}
        backgroundColor=${c?.backgroundColor}
        iconColor=${u}
        icon=${i}
        .loading=${'loading'===r}
      ></wui-snackbar>
    `}onOpen(){clearTimeout(this.timeout),this.open?(this.animate([{opacity:0,transform:'translateX(-50%) scale(0.85)'},{opacity:1,transform:'translateX(-50%) scale(1)'}],{duration:150,fill:'forwards',easing:'ease'}),this.timeout&&clearTimeout(this.timeout),n.SnackController.state.autoClose&&(this.timeout=setTimeout(()=>n.SnackController.hide(),2500))):this.animate([{opacity:1,transform:'translateX(-50%) scale(1)'},{opacity:0,transform:'translateX(-50%) scale(0.85)'}],{duration:150,fill:'forwards',easing:'ease'})}};u.styles=c.default,i([(0,r.state)()],u.prototype,"open",void 0),e.W3mSnackBar=u=i([(0,s.customElement)('w3m-snackbar')],u)},7048,[2,4949,4958,4629,4946,7049,7052]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0});var n=r(d[0]);Object.keys(n).forEach(function(t){"default"!==t&&"__esModule"!==t&&(t in e&&e[t]===n[t]||Object.defineProperty(e,t,{enumerable:!0,get:function(){return n[t]}}))})},7049,[7050]);
__d(function(g,_r,_i,a,m,e,_d){var o=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.WuiSnackbar=void 0;var t=_r(_d[1]),i=_r(_d[2]);_r(_d[3]),_r(_d[4]),_r(_d[5]);var r=_r(_d[6]),n=_r(_d[7]);_r(_d[8]);var c=o(_r(_d[9])),s=this&&this.__decorate||function(o,t,i,r){var n,c=arguments.length,s=c<3?t:null===r?r=Object.getOwnPropertyDescriptor(t,i):r;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)s=Reflect.decorate(o,t,i,r);else for(var l=o.length-1;l>=0;l--)(n=o[l])&&(s=(c<3?n(s):c>3?n(t,i,s):n(t,i))||s);return c>3&&s&&Object.defineProperty(t,i,s),s};let l=e.WuiSnackbar=class extends t.LitElement{constructor(){super(...arguments),this.backgroundColor='accent-100',this.iconColor='accent-100',this.icon='checkmark',this.message='',this.loading=!1,this.iconType='default'}render(){return t.html`
      ${this.templateIcon()}
      <wui-text variant="paragraph-500" color="fg-100" data-testid="wui-snackbar-message"
        >${this.message}</wui-text
      >
    `}templateIcon(){return this.loading?t.html`<wui-loading-spinner size="md" color="accent-100"></wui-loading-spinner>`:'default'===this.iconType?t.html`<wui-icon size="xl" color=${this.iconColor} name=${this.icon}></wui-icon>`:t.html`<wui-icon-box
      size="sm"
      iconSize="xs"
      iconColor=${this.iconColor}
      backgroundColor=${this.backgroundColor}
      icon=${this.icon}
      background="opaque"
    ></wui-icon-box>`}};l.styles=[r.resetStyles,c.default],s([(0,i.property)()],l.prototype,"backgroundColor",void 0),s([(0,i.property)()],l.prototype,"iconColor",void 0),s([(0,i.property)()],l.prototype,"icon",void 0),s([(0,i.property)()],l.prototype,"message",void 0),s([(0,i.property)()],l.prototype,"loading",void 0),s([(0,i.property)()],l.prototype,"iconType",void 0),e.WuiSnackbar=l=s([(0,n.customElement)('wui-snackbar')],l)},7050,[2,4949,4958,4974,4993,4983,4948,4957,4987,7051]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var s=r(d[0]);e.default=s.css`
  :host {
    display: flex;
    column-gap: var(--wui-spacing-s);
    align-items: center;
    padding: var(--wui-spacing-xs) var(--wui-spacing-m) var(--wui-spacing-xs) var(--wui-spacing-xs);
    border-radius: var(--wui-border-radius-s);
    border: 1px solid var(--wui-color-gray-glass-005);
    box-sizing: border-box;
    background-color: var(--wui-color-bg-175);
    box-shadow:
      0px 14px 64px -4px rgba(0, 0, 0, 0.15),
      0px 8px 22px -6px rgba(0, 0, 0, 0.15);

    max-width: 300px;
  }

  :host wui-loading-spinner {
    margin-left: var(--wui-spacing-3xs);
  }
`},7051,[4949]);
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
`},7052,[4949]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.W3mTooltip=void 0;var o=_r(_d[1]),i=_r(_d[2]),r=_r(_d[3]),s=_r(_d[4]);_r(_d[5]),_r(_d[6]),_r(_d[7]);var n=t(_r(_d[8])),l=this&&this.__decorate||function(t,o,i,r){var s,n=arguments.length,l=n<3?o:null===r?r=Object.getOwnPropertyDescriptor(o,i):r;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)l=Reflect.decorate(t,o,i,r);else for(var p=t.length-1;p>=0;p--)(s=t[p])&&(l=(n<3?s(l):n>3?s(o,i,l):s(o,i))||l);return n>3&&l&&Object.defineProperty(o,i,l),l};let p=e.W3mTooltip=class extends o.LitElement{constructor(){super(),this.unsubscribe=[],this.open=r.TooltipController.state.open,this.message=r.TooltipController.state.message,this.triggerRect=r.TooltipController.state.triggerRect,this.variant=r.TooltipController.state.variant,this.unsubscribe.push(r.TooltipController.subscribe(t=>{this.open=t.open,this.message=t.message,this.triggerRect=t.triggerRect,this.variant=t.variant}))}disconnectedCallback(){this.unsubscribe.forEach(t=>t())}render(){this.dataset.variant=this.variant;const t=this.triggerRect.top,i=this.triggerRect.left;return this.style.cssText=`\n    --w3m-tooltip-top: ${t}px;\n    --w3m-tooltip-left: ${i}px;\n    --w3m-tooltip-parent-width: ${this.triggerRect.width/2}px;\n    --w3m-tooltip-display: ${this.open?'flex':'none'};\n    --w3m-tooltip-opacity: ${this.open?1:0};\n    `,o.html`<wui-flex>
      <wui-icon data-placement="top" color="fg-100" size="inherit" name="cursor"></wui-icon>
      <wui-text color="inherit" variant="small-500">${this.message}</wui-text>
    </wui-flex>`}};p.styles=[n.default],l([(0,i.state)()],p.prototype,"open",void 0),l([(0,i.state)()],p.prototype,"message",void 0),l([(0,i.state)()],p.prototype,"triggerRect",void 0),l([(0,i.state)()],p.prototype,"variant",void 0),e.W3mTooltip=p=l([(0,s.customElement)('w3m-tooltip'),(0,s.customElement)('w3m-tooltip')],p)},7053,[2,4949,4958,4629,4946,4969,4995,4996,7054]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var t=r(d[0]);e.default=t.css`
  :host {
    pointer-events: none;
  }

  :host > wui-flex {
    display: var(--w3m-tooltip-display);
    opacity: var(--w3m-tooltip-opacity);
    padding: 9px var(--wui-spacing-s) 10px var(--wui-spacing-s);
    border-radius: var(--wui-border-radius-xxs);
    color: var(--wui-color-bg-100);
    position: fixed;
    top: var(--w3m-tooltip-top);
    left: var(--w3m-tooltip-left);
    transform: translate(calc(-50% + var(--w3m-tooltip-parent-width)), calc(-100% - 8px));
    max-width: calc(var(--w3m-modal-width) - var(--wui-spacing-xl));
    transition: opacity 0.2s var(--wui-ease-out-power-2);
    will-change: opacity;
  }

  :host([data-variant='shade']) > wui-flex {
    background-color: var(--wui-color-bg-150);
    border: 1px solid var(--wui-color-gray-glass-005);
  }

  :host([data-variant='shade']) > wui-flex > wui-text {
    color: var(--wui-color-fg-150);
  }

  :host([data-variant='fill']) > wui-flex {
    background-color: var(--wui-color-fg-100);
    border: none;
  }

  wui-icon {
    position: absolute;
    width: 12px !important;
    height: 4px !important;
    color: var(--wui-color-bg-150);
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
`},7054,[4949]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.W3mRouter=void 0;var i=_r(_d[1]),n=_r(_d[2]),w=_r(_d[3]),r=_r(_d[4]),s=_r(_d[5]),c=t(_r(_d[6])),l=this&&this.__decorate||function(t,i,n,w){var r,s=arguments.length,c=s<3?i:null===w?w=Object.getOwnPropertyDescriptor(i,n):w;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)c=Reflect.decorate(t,i,n,w);else for(var l=t.length-1;l>=0;l--)(r=t[l])&&(c=(s<3?r(c):s>3?r(i,n,c):r(i,n))||c);return s>3&&c&&Object.defineProperty(i,n,c),c};let o=e.W3mRouter=class extends i.LitElement{constructor(){super(),this.resizeObserver=void 0,this.prevHeight='0px',this.prevHistoryLength=1,this.unsubscribe=[],this.view=w.RouterController.state.view,this.viewDirection='',this.unsubscribe.push(w.RouterController.subscribeKey('view',t=>this.onViewChange(t)))}firstUpdated(){this.resizeObserver=new ResizeObserver(([t])=>{const i=`${t?.contentRect.height}px`;'0px'!==this.prevHeight&&(this.style.setProperty('--prev-height',this.prevHeight),this.style.setProperty('--new-height',i),this.style.animation='w3m-view-height 150ms forwards ease',this.style.height='auto'),setTimeout(()=>{this.prevHeight=i,this.style.animation='unset'},s.ConstantsUtil.ANIMATION_DURATIONS.ModalHeight)}),this.resizeObserver?.observe(this.getWrapper())}disconnectedCallback(){this.resizeObserver?.unobserve(this.getWrapper()),this.unsubscribe.forEach(t=>t())}render(){return i.html`<div class="w3m-router-container" view-direction="${this.viewDirection}">
      ${this.viewTemplate()}
    </div>`}viewTemplate(){switch(this.view){case'AccountSettings':return i.html`<w3m-account-settings-view></w3m-account-settings-view>`;case'Account':return i.html`<w3m-account-view></w3m-account-view>`;case'AllWallets':return i.html`<w3m-all-wallets-view></w3m-all-wallets-view>`;case'ApproveTransaction':return i.html`<w3m-approve-transaction-view></w3m-approve-transaction-view>`;case'BuyInProgress':return i.html`<w3m-buy-in-progress-view></w3m-buy-in-progress-view>`;case'ChooseAccountName':return i.html`<w3m-choose-account-name-view></w3m-choose-account-name-view>`;case'Connect':default:return i.html`<w3m-connect-view></w3m-connect-view>`;case'Create':return i.html`<w3m-connect-view walletGuide="explore"></w3m-connect-view>`;case'ConnectingWalletConnect':return i.html`<w3m-connecting-wc-view></w3m-connecting-wc-view>`;case'ConnectingWalletConnectBasic':return i.html`<w3m-connecting-wc-basic-view></w3m-connecting-wc-basic-view>`;case'ConnectingExternal':return i.html`<w3m-connecting-external-view></w3m-connecting-external-view>`;case'ConnectingSiwe':return i.html`<w3m-connecting-siwe-view></w3m-connecting-siwe-view>`;case'ConnectWallets':return i.html`<w3m-connect-wallets-view></w3m-connect-wallets-view>`;case'ConnectSocials':return i.html`<w3m-connect-socials-view></w3m-connect-socials-view>`;case'ConnectingSocial':return i.html`<w3m-connecting-social-view></w3m-connecting-social-view>`;case'Downloads':return i.html`<w3m-downloads-view></w3m-downloads-view>`;case'EmailLogin':return i.html`<w3m-email-login-view></w3m-email-login-view>`;case'EmailVerifyOtp':return i.html`<w3m-email-verify-otp-view></w3m-email-verify-otp-view>`;case'EmailVerifyDevice':return i.html`<w3m-email-verify-device-view></w3m-email-verify-device-view>`;case'GetWallet':return i.html`<w3m-get-wallet-view></w3m-get-wallet-view>`;case'Networks':return i.html`<w3m-networks-view></w3m-networks-view>`;case'SwitchNetwork':return i.html`<w3m-network-switch-view></w3m-network-switch-view>`;case'Profile':return i.html`<w3m-profile-view></w3m-profile-view>`;case'SwitchAddress':return i.html`<w3m-switch-address-view></w3m-switch-address-view>`;case'Transactions':return i.html`<w3m-transactions-view></w3m-transactions-view>`;case'OnRampProviders':return i.html`<w3m-onramp-providers-view></w3m-onramp-providers-view>`;case'OnRampActivity':return i.html`<w3m-onramp-activity-view></w3m-onramp-activity-view>`;case'OnRampTokenSelect':return i.html`<w3m-onramp-token-select-view></w3m-onramp-token-select-view>`;case'OnRampFiatSelect':return i.html`<w3m-onramp-fiat-select-view></w3m-onramp-fiat-select-view>`;case'UpgradeEmailWallet':return i.html`<w3m-upgrade-wallet-view></w3m-upgrade-wallet-view>`;case'UpdateEmailWallet':return i.html`<w3m-update-email-wallet-view></w3m-update-email-wallet-view>`;case'UpdateEmailPrimaryOtp':return i.html`<w3m-update-email-primary-otp-view></w3m-update-email-primary-otp-view>`;case'UpdateEmailSecondaryOtp':return i.html`<w3m-update-email-secondary-otp-view></w3m-update-email-secondary-otp-view>`;case'UnsupportedChain':return i.html`<w3m-unsupported-chain-view></w3m-unsupported-chain-view>`;case'Swap':return i.html`<w3m-swap-view></w3m-swap-view>`;case'SwapSelectToken':return i.html`<w3m-swap-select-token-view></w3m-swap-select-token-view>`;case'SwapPreview':return i.html`<w3m-swap-preview-view></w3m-swap-preview-view>`;case'WalletSend':return i.html`<w3m-wallet-send-view></w3m-wallet-send-view>`;case'WalletSendSelectToken':return i.html`<w3m-wallet-send-select-token-view></w3m-wallet-send-select-token-view>`;case'WalletSendPreview':return i.html`<w3m-wallet-send-preview-view></w3m-wallet-send-preview-view>`;case'WhatIsABuy':return i.html`<w3m-what-is-a-buy-view></w3m-what-is-a-buy-view>`;case'WalletReceive':return i.html`<w3m-wallet-receive-view></w3m-wallet-receive-view>`;case'WalletCompatibleNetworks':return i.html`<w3m-wallet-compatible-networks-view></w3m-wallet-compatible-networks-view>`;case'WhatIsAWallet':return i.html`<w3m-what-is-a-wallet-view></w3m-what-is-a-wallet-view>`;case'ConnectingMultiChain':return i.html`<w3m-connecting-multi-chain-view></w3m-connecting-multi-chain-view>`;case'WhatIsANetwork':return i.html`<w3m-what-is-a-network-view></w3m-what-is-a-network-view>`;case'ConnectingFarcaster':return i.html`<w3m-connecting-farcaster-view></w3m-connecting-farcaster-view>`;case'SwitchActiveChain':return i.html`<w3m-switch-active-chain-view></w3m-switch-active-chain-view>`;case'RegisterAccountName':return i.html`<w3m-register-account-name-view></w3m-register-account-name-view>`;case'RegisterAccountNameSuccess':return i.html`<w3m-register-account-name-success-view></w3m-register-account-name-success-view>`;case'SmartSessionCreated':return i.html`<w3m-smart-session-created-view></w3m-smart-session-created-view>`;case'SmartSessionList':return i.html`<w3m-smart-session-list-view></w3m-smart-session-list-view>`;case'SIWXSignMessage':return i.html`<w3m-siwx-sign-message-view></w3m-siwx-sign-message-view>`;case'Pay':return i.html`<w3m-pay-view></w3m-pay-view>`;case'PayLoading':return i.html`<w3m-pay-loading-view></w3m-pay-loading-view>`}}onViewChange(t){w.TooltipController.hide();let i=s.ConstantsUtil.VIEW_DIRECTION.Next;const{history:n}=w.RouterController.state;n.length<this.prevHistoryLength&&(i=s.ConstantsUtil.VIEW_DIRECTION.Prev),this.prevHistoryLength=n.length,this.viewDirection=i,setTimeout(()=>{this.view=t},s.ConstantsUtil.ANIMATION_DURATIONS.ViewTransition)}getWrapper(){return this.shadowRoot?.querySelector('div')}};o.styles=c.default,l([(0,n.state)()],o.prototype,"view",void 0),l([(0,n.state)()],o.prototype,"viewDirection",void 0),e.W3mRouter=o=l([(0,r.customElement)('w3m-router')],o)},7055,[2,4949,4958,4629,4946,4945,7056]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var t=r(d[0]);e.default=t.css`
  :host {
    --prev-height: 0px;
    --new-height: 0px;
    display: block;
  }

  div.w3m-router-container {
    transform: translateY(0);
    opacity: 1;
  }

  div.w3m-router-container[view-direction='prev'] {
    animation:
      slide-left-out 150ms forwards ease,
      slide-left-in 150ms forwards ease;
    animation-delay: 0ms, 200ms;
  }

  div.w3m-router-container[view-direction='next'] {
    animation:
      slide-right-out 150ms forwards ease,
      slide-right-in 150ms forwards ease;
    animation-delay: 0ms, 200ms;
  }

  @keyframes slide-left-out {
    from {
      transform: translateX(0px);
      opacity: 1;
    }
    to {
      transform: translateX(10px);
      opacity: 0;
    }
  }

  @keyframes slide-left-in {
    from {
      transform: translateX(-10px);
      opacity: 0;
    }
    to {
      transform: translateX(0);
      opacity: 1;
    }
  }

  @keyframes slide-right-out {
    from {
      transform: translateX(0px);
      opacity: 1;
    }
    to {
      transform: translateX(-10px);
      opacity: 0;
    }
  }

  @keyframes slide-right-in {
    from {
      transform: translateX(10px);
      opacity: 0;
    }
    to {
      transform: translateX(0);
      opacity: 1;
    }
  }
`},7056,[4949]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var t=r(d[0]);e.default=t.css`
  :host {
    z-index: var(--w3m-z-index);
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
    background-color: var(--wui-cover);
    transition: opacity 0.2s var(--wui-ease-out-power-2);
    will-change: opacity;
  }

  :host(.open) {
    opacity: 1;
  }

  :host(.appkit-modal) {
    position: relative;
    pointer-events: unset;
    background: none;
    width: 100%;
    opacity: 1;
  }

  wui-card {
    max-width: var(--w3m-modal-width);
    width: 100%;
    position: relative;
    animation: zoom-in 0.2s var(--wui-ease-out-power-2);
    animation-fill-mode: backwards;
    outline: none;
    transition:
      border-radius var(--wui-duration-lg) var(--wui-ease-out-power-1),
      background-color var(--wui-duration-lg) var(--wui-ease-out-power-1);
    will-change: border-radius, background-color;
  }

  :host(.appkit-modal) wui-card {
    max-width: 400px;
  }

  wui-card[shake='true'] {
    animation:
      zoom-in 0.2s var(--wui-ease-out-power-2),
      w3m-shake 0.5s var(--wui-ease-out-power-2);
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
      margin: var(--wui-spacing-xxl) 0px;
    }
  }

  @media (max-width: 430px) {
    wui-flex {
      align-items: flex-end;
    }

    wui-card {
      max-width: 100%;
      border-bottom-left-radius: var(--local-border-bottom-mobile-radius);
      border-bottom-right-radius: var(--local-border-bottom-mobile-radius);
      border-bottom: none;
      animation: slide-in 0.2s var(--wui-ease-out-power-2);
    }

    wui-card[shake='true'] {
      animation:
        slide-in 0.2s var(--wui-ease-out-power-2),
        w3m-shake 0.5s var(--wui-ease-out-power-2);
    }
  }

  @keyframes zoom-in {
    0% {
      transform: scale(0.95) translateY(0);
    }
    100% {
      transform: scale(1) translateY(0);
    }
  }

  @keyframes slide-in {
    0% {
      transform: scale(1) translateY(50px);
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

  @keyframes w3m-view-height {
    from {
      height: var(--prev-height);
    }
    to {
      height: var(--new-height);
    }
  }
`},7057,[4949]);