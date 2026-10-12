__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0});var n=r(d[0]);Object.keys(n).forEach(function(t){"default"!==t&&"__esModule"!==t&&(t in e&&e[t]===n[t]||Object.defineProperty(e,t,{enumerable:!0,get:function(){return n[t]}}))});var t=r(d[1]);Object.keys(t).forEach(function(n){"default"!==n&&"__esModule"!==n&&(n in e&&e[n]===t[n]||Object.defineProperty(e,n,{enumerable:!0,get:function(){return t[n]}}))});var u=r(d[2]);Object.keys(u).forEach(function(n){"default"!==n&&"__esModule"!==n&&(n in e&&e[n]===u[n]||Object.defineProperty(e,n,{enumerable:!0,get:function(){return u[n]}}))})},5989,[5992,6054,6081]);
__d(function(g,_r,_i,a,m,e,_d){Object.defineProperty(e,"__esModule",{value:!0}),e.W3mConnectingWcBasicView=void 0;var t=_r(_d[0]),i=_r(_d[1]),n=_r(_d[2]),l=_r(_d[3]);_r(_d[4]),_r(_d[5]),_r(_d[6]),_r(_d[7]);var r=this&&this.__decorate||function(t,i,n,l){var r,o=arguments.length,s=o<3?i:null===l?l=Object.getOwnPropertyDescriptor(i,n):l;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)s=Reflect.decorate(t,i,n,l);else for(var c=t.length-1;c>=0;c--)(r=t[c])&&(s=(o<3?r(s):o>3?r(i,n,s):r(i,n))||s);return o>3&&s&&Object.defineProperty(i,n,s),s};let o=e.W3mConnectingWcBasicView=class extends t.LitElement{constructor(){super(),this.unsubscribe=[],this.isMobile=n.CoreHelperUtil.isMobile(),this.remoteFeatures=n.OptionsController.state.remoteFeatures,this.unsubscribe.push(n.OptionsController.subscribeKey('remoteFeatures',t=>this.remoteFeatures=t))}disconnectedCallback(){this.unsubscribe.forEach(t=>t())}render(){if(this.isMobile){const{featured:i,recommended:l}=n.ApiController.state,{customWallets:r}=n.OptionsController.state,o=n.StorageUtil.getRecentWallets(),s=i.length||l.length||r?.length||o.length;return t.html`<wui-flex flexDirection="column" gap="2" .margin=${['1','3','3','3']}>
        ${s?t.html`<w3m-connector-list></w3m-connector-list>`:null}
        <w3m-all-wallets-widget></w3m-all-wallets-widget>
      </wui-flex>`}return t.html`<wui-flex flexDirection="column" .padding=${['0','0','4','0']}>
        <w3m-connecting-wc-view ?basic=${!0} .displayBranding=${!1}></w3m-connecting-wc-view>
        <wui-flex flexDirection="column" .padding=${['0','3','0','3']}>
          <w3m-all-wallets-widget></w3m-all-wallets-widget>
        </wui-flex>
      </wui-flex>
      ${this.reownBrandingTemplate()} `}reownBrandingTemplate(){return this.remoteFeatures?.reownBranding?t.html` <wui-flex flexDirection="column" .padding=${['1','0','1','0']}>
      <wui-ux-by-reown></wui-ux-by-reown>
    </wui-flex>`:null}};r([(0,i.state)()],o.prototype,"isMobile",void 0),r([(0,i.state)()],o.prototype,"remoteFeatures",void 0),e.W3mConnectingWcBasicView=o=r([(0,l.customElement)('w3m-connecting-wc-basic-view')],o)},5992,[4553,4574,4532,4550,4585,5993,5994,5996]);
__d(function(g,_r,_i,a,m,e,_d){Object.defineProperty(e,"__esModule",{value:!0}),e.W3mAllWalletsWidget=void 0;var t=_r(_d[0]),l=_r(_d[1]),o=_r(_d[2]),n=_r(_d[3]),s=_r(_d[4]),i=_r(_d[5]);_r(_d[6]);var r=this&&this.__decorate||function(t,l,o,n){var s,i=arguments.length,r=i<3?l:null===n?n=Object.getOwnPropertyDescriptor(l,o):n;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)r=Reflect.decorate(t,l,o,n);else for(var c=t.length-1;c>=0;c--)(s=t[c])&&(r=(i<3?s(r):i>3?s(l,o,r):s(l,o))||r);return i>3&&r&&Object.defineProperty(l,o,r),r};let c=e.W3mAllWalletsWidget=class extends t.LitElement{constructor(){super(),this.unsubscribe=[],this.tabIdx=void 0,this.connectors=s.ConnectorController.state.connectors,this.count=s.ApiController.state.count,this.filteredCount=s.ApiController.state.filteredWallets.length,this.isFetchingRecommendedWallets=s.ApiController.state.isFetchingRecommendedWallets,this.unsubscribe.push(s.ConnectorController.subscribeKey('connectors',t=>this.connectors=t),s.ApiController.subscribeKey('count',t=>this.count=t),s.ApiController.subscribeKey('filteredWallets',t=>this.filteredCount=t.length),s.ApiController.subscribeKey('isFetchingRecommendedWallets',t=>this.isFetchingRecommendedWallets=t))}disconnectedCallback(){this.unsubscribe.forEach(t=>t())}render(){const l=this.connectors.find(t=>'walletConnect'===t.id),{allWallets:i}=s.OptionsController.state;if(!l||'HIDE'===i)return null;if('ONLY_MOBILE'===i&&!s.CoreHelperUtil.isMobile())return null;const r=s.ApiController.state.featured.length,c=this.count+r,d=c<10?c:10*Math.floor(c/10),u=this.filteredCount>0?this.filteredCount:d;let h=`${u}`;this.filteredCount>0?h=`${this.filteredCount}`:u<c&&(h=`${u}+`);const C=s.ConnectionController.hasAnyConnection(n.ConstantsUtil.CONNECTOR_ID.WALLET_CONNECT);return t.html`
      <wui-list-wallet
        name="Search Wallet"
        walletIcon="search"
        showAllWallets
        @click=${this.onAllWallets.bind(this)}
        tagLabel=${h}
        tagVariant="info"
        data-testid="all-wallets"
        tabIdx=${(0,o.ifDefined)(this.tabIdx)}
        .loading=${this.isFetchingRecommendedWallets}
        ?disabled=${C}
        size="sm"
      ></wui-list-wallet>
    `}onAllWallets(){s.EventsController.sendEvent({type:'track',event:'CLICK_ALL_WALLETS'}),s.RouterController.push('AllWallets',{redirectView:s.RouterController.state.data?.redirectView})}};r([(0,l.property)()],c.prototype,"tabIdx",void 0),r([(0,l.state)()],c.prototype,"connectors",void 0),r([(0,l.state)()],c.prototype,"count",void 0),r([(0,l.state)()],c.prototype,"filteredCount",void 0),r([(0,l.state)()],c.prototype,"isFetchingRecommendedWallets",void 0),e.W3mAllWalletsWidget=c=r([(0,i.customElement)('w3m-all-wallets-widget')],c)},5993,[4553,4574,4588,4456,4532,4550,4590]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.W3mConnectorList=void 0;var n=_r(_d[1]),o=_r(_d[2]),r=_r(_d[3]),l=_r(_d[4]),i=_r(_d[5]),c=_r(_d[6]);_r(_d[7]);var s=_r(_d[8]),d=t(_r(_d[9])),C=this&&this.__decorate||function(t,n,o,r){var l,i=arguments.length,c=i<3?n:null===r?r=Object.getOwnPropertyDescriptor(n,o):r;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)c=Reflect.decorate(t,n,o,r);else for(var s=t.length-1;s>=0;s--)(l=t[s])&&(c=(i<3?l(c):i>3?l(n,o,c):l(n,o))||c);return i>3&&c&&Object.defineProperty(n,o,c),c};let u=e.W3mConnectorList=class extends n.LitElement{constructor(){super(),this.unsubscribe=[],this.explorerWallets=i.ApiController.state.explorerWallets,this.connections=i.ConnectionController.state.connections,this.connectorImages=i.AssetController.state.connectorImages,this.loadingTelegram=!1,this.unsubscribe.push(i.ConnectionController.subscribeKey('connections',t=>this.connections=t),i.AssetController.subscribeKey('connectorImages',t=>this.connectorImages=t),i.ApiController.subscribeKey('explorerFilteredWallets',t=>{this.explorerWallets=t?.length?t:i.ApiController.state.explorerWallets}),i.ApiController.subscribeKey('explorerWallets',t=>{this.explorerWallets?.length||(this.explorerWallets=t)})),i.CoreHelperUtil.isTelegram()&&i.CoreHelperUtil.isIos()&&(this.loadingTelegram=!i.ConnectionController.state.wcUri,this.unsubscribe.push(i.ConnectionController.subscribeKey('wcUri',t=>this.loadingTelegram=!t)))}disconnectedCallback(){this.unsubscribe.forEach(t=>t())}render(){return n.html`
      <wui-flex flexDirection="column" gap="2"> ${this.connectorListTemplate()} </wui-flex>
    `}connectorListTemplate(){return i.ConnectorUtil.connectorList().map((t,n)=>'connector'===t.kind?this.renderConnector(t,n):this.renderWallet(t,n))}getConnectorNamespaces(t){return'walletConnect'===t.subtype?[]:'multiChain'===t.subtype?t.connector.connectors?.map(t=>t.chain)||[]:[t.connector.chain]}renderConnector(t,o){const c=t.connector,d=i.AssetUtil.getConnectorImage(c)||this.connectorImages[c?.imageId??''],C=(this.connections.get(c.chain)??[]).some(t=>s.HelpersUtil.isLowerCaseMatch(t.connectorId,c.id));let u,p;'walletConnect'===t.subtype?(u='qr code',p='accent'):'injected'===t.subtype||'announced'===t.subtype?(u=C?'connected':'installed',p=C?'info':'success'):(u=void 0,p=void 0);const h=i.ConnectionController.hasAnyConnection(l.ConstantsUtil.CONNECTOR_ID.WALLET_CONNECT),b=('walletConnect'===t.subtype||'external'===t.subtype)&&h;return n.html`
      <w3m-list-wallet
        displayIndex=${o}
        imageSrc=${(0,r.ifDefined)(d)}
        .installed=${!0}
        name=${c.name??'Unknown'}
        .tagVariant=${p}
        tagLabel=${(0,r.ifDefined)(u)}
        data-testid=${`wallet-selector-${c.id.toLowerCase()}`}
        size="sm"
        @click=${()=>this.onClickConnector(t)}
        tabIdx=${(0,r.ifDefined)(this.tabIdx)}
        ?disabled=${b}
        rdnsId=${(0,r.ifDefined)(c.explorerWallet?.rdns||void 0)}
        walletRank=${(0,r.ifDefined)(c.explorerWallet?.order)}
        .namespaces=${this.getConnectorNamespaces(t)}
      >
      </w3m-list-wallet>
    `}onClickConnector(t){const n=i.RouterController.state.data?.redirectView;return'walletConnect'===t.subtype?(i.ConnectorController.setActiveConnector(t.connector),void(i.CoreHelperUtil.isMobile()?i.RouterController.push('AllWallets'):i.RouterController.push('ConnectingWalletConnect',{redirectView:n}))):'multiChain'===t.subtype?(i.ConnectorController.setActiveConnector(t.connector),void i.RouterController.push('ConnectingMultiChain',{redirectView:n})):'injected'===t.subtype?(i.ConnectorController.setActiveConnector(t.connector),void i.RouterController.push('ConnectingExternal',{connector:t.connector,redirectView:n,wallet:t.connector.explorerWallet})):'announced'===t.subtype?'walletConnect'===t.connector.id?void(i.CoreHelperUtil.isMobile()?i.RouterController.push('AllWallets'):i.RouterController.push('ConnectingWalletConnect',{redirectView:n})):void i.RouterController.push('ConnectingExternal',{connector:t.connector,redirectView:n,wallet:t.connector.explorerWallet}):void i.RouterController.push('ConnectingExternal',{connector:t.connector,redirectView:n})}renderWallet(t,o){const c=t.wallet,s=i.AssetUtil.getWalletImage(c),d=i.ConnectionController.hasAnyConnection(l.ConstantsUtil.CONNECTOR_ID.WALLET_CONNECT),C=this.loadingTelegram,u='recent'===t.subtype?'recent':void 0,p='recent'===t.subtype?'info':void 0;return n.html`
      <w3m-list-wallet
        displayIndex=${o}
        imageSrc=${(0,r.ifDefined)(s)}
        name=${c.name??'Unknown'}
        @click=${()=>this.onClickWallet(t)}
        size="sm"
        data-testid=${`wallet-selector-${c.id}`}
        tabIdx=${(0,r.ifDefined)(this.tabIdx)}
        ?loading=${C}
        ?disabled=${d}
        rdnsId=${(0,r.ifDefined)(c.rdns||void 0)}
        walletRank=${(0,r.ifDefined)(c.order)}
        tagLabel=${(0,r.ifDefined)(u)}
        .tagVariant=${p}
      >
      </w3m-list-wallet>
    `}onClickWallet(t){const n=i.RouterController.state.data?.redirectView,o=i.ChainController.state.activeChain;if('featured'===t.subtype)return void i.ConnectorController.selectWalletConnector(t.wallet);if('recent'===t.subtype){if(this.loadingTelegram)return;return void i.ConnectorController.selectWalletConnector(t.wallet)}if('custom'===t.subtype){if(this.loadingTelegram)return;return void i.RouterController.push('ConnectingWalletConnect',{wallet:t.wallet,redirectView:n})}if(this.loadingTelegram)return;const r=o?i.ConnectorController.getConnector({id:t.wallet.id,namespace:o}):void 0;r?i.RouterController.push('ConnectingExternal',{connector:r,redirectView:n}):i.RouterController.push('ConnectingWalletConnect',{wallet:t.wallet,redirectView:n})}};u.styles=d.default,C([(0,o.property)({type:Number})],u.prototype,"tabIdx",void 0),C([(0,o.state)()],u.prototype,"explorerWallets",void 0),C([(0,o.state)()],u.prototype,"connections",void 0),C([(0,o.state)()],u.prototype,"connectorImages",void 0),C([(0,o.state)()],u.prototype,"loadingTelegram",void 0),e.W3mConnectorList=u=C([(0,c.customElement)('w3m-connector-list')],u)},5994,[2,4553,4574,4588,4456,4532,4550,4585,4564,5995]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var c=r(d[0]);e.default=c.css`
  :host {
    margin-top: ${({spacing:c})=>c[1]};
  }
  wui-separator {
    margin: ${({spacing:c})=>c[3]} calc(${({spacing:c})=>c[3]} * -1)
      ${({spacing:c})=>c[2]} calc(${({spacing:c})=>c[3]} * -1);
    width: calc(100% + ${({spacing:c})=>c[3]} * 2);
  }
`},5995,[4550]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.W3mConnectingWcView=void 0;var o=_r(_d[1]),n=_r(_d[2]),r=_r(_d[3]),i=_r(_d[4]),l=_r(_d[5]),s=_r(_d[6]);_r(_d[7]),_r(_d[8]),_r(_d[9]),_r(_d[10]),_r(_d[11]),_r(_d[12]),_r(_d[13]);var c=t(_r(_d[14])),p=this&&this.__decorate||function(t,o,n,r){var i,l=arguments.length,s=l<3?o:null===r?r=Object.getOwnPropertyDescriptor(o,n):r;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)s=Reflect.decorate(t,o,n,r);else for(var c=t.length-1;c>=0;c--)(i=t[c])&&(s=(l<3?i(s):l>3?i(o,n,s):i(o,n))||s);return l>3&&s&&Object.defineProperty(o,n,s),s};let h=e.W3mConnectingWcView=class extends o.LitElement{constructor(){super(),this.wallet=i.RouterController.state.data?.wallet,this.unsubscribe=[],this.platform=void 0,this.platforms=[],this.isSiwxEnabled=Boolean(i.OptionsController.state.siwx),this.remoteFeatures=i.OptionsController.state.remoteFeatures,this.displayBranding=!0,this.basic=!1,this.determinePlatforms(),this.initializeConnection(),this.unsubscribe.push(i.OptionsController.subscribeKey('remoteFeatures',t=>this.remoteFeatures=t))}disconnectedCallback(){this.unsubscribe.forEach(t=>t())}render(){return i.OptionsController.state.enableMobileFullScreen&&this.setAttribute('data-mobile-fullscreen','true'),o.html`
      ${this.headerTemplate()}
      <div class="platform-container">${this.platformTemplate()}</div>
      ${this.reownBrandingTemplate()}
    `}reownBrandingTemplate(){return this.remoteFeatures?.reownBranding&&this.displayBranding?o.html`<wui-ux-by-reown></wui-ux-by-reown>`:null}async initializeConnection(t=!1){if('browser'!==this.platform&&(!i.OptionsController.state.manualWCControl||t))try{const{wcPairingExpiry:o,status:n}=i.ConnectionController.state,{redirectView:r}=i.RouterController.state.data??{};if(t||i.OptionsController.state.enableEmbedded||i.CoreHelperUtil.isPairingExpired(o)||'connecting'===n){const t=i.ConnectionController.getConnections(i.ChainController.state.activeChain),o=this.remoteFeatures?.multiWallet,n=t.length>0;await i.ConnectionController.connectWalletConnect({cache:'never'}),this.isSiwxEnabled||(n&&o?(i.RouterController.replace('ProfileWallets'),i.SnackController.showSuccess('New Wallet Added')):r?i.RouterController.replace(r):i.ModalController.close())}}catch(t){if(t instanceof Error&&t.message.includes('An error occurred when attempting to switch chain')&&!i.OptionsController.state.enableNetworkSwitch&&i.ChainController.state.activeChain)return i.ChainController.setActiveCaipNetwork(s.CaipNetworksUtil.getUnsupportedNetwork(`${i.ChainController.state.activeChain}:${i.ChainController.state.activeCaipNetwork?.id}`)),void i.ChainController.showUnsupportedChainUI();t instanceof i.AppKitError&&t.originalName===r.ErrorUtil.PROVIDER_RPC_ERROR_NAME.USER_REJECTED_REQUEST?i.EventsController.sendEvent({type:'track',event:'USER_REJECTED',properties:{message:t.message}}):i.EventsController.sendEvent({type:'track',event:'CONNECT_ERROR',properties:{message:t?.message??'Unknown'}}),i.ConnectionController.setWcError(!0),i.SnackController.showError(t.message??'Connection error'),i.ConnectionController.resetWcConnection(),i.RouterController.goBack()}}determinePlatforms(){if(!this.wallet)return this.platforms.push('qrcode'),void(this.platform='qrcode');if(this.platform)return;const{mobile_link:t,desktop_link:o,webapp_link:n,injected:r,rdns:l}=this.wallet,s=r?.map(({injected_id:t})=>t).filter(Boolean),c=[...l?[l]:s??[]],p=!i.OptionsController.state.isUniversalProvider&&c.length,h=t,d=n,w=i.ConnectionController.checkInstalled(c),C=p&&w,u=o&&!i.CoreHelperUtil.isMobile();C&&!i.ChainController.state.noAdapters&&this.platforms.push('browser'),h&&this.platforms.push(i.CoreHelperUtil.isMobile()?'mobile':'qrcode'),d&&this.platforms.push('web'),u&&this.platforms.push('desktop');const f=i.MobileWalletUtil.isCustomDeeplinkWallet(this.wallet.id,i.ChainController.state.activeChain);C||!p||i.ChainController.state.noAdapters||f||this.platforms.push('unsupported'),this.platform=this.platforms[0]}platformTemplate(){switch(this.platform){case'browser':return o.html`<w3m-connecting-wc-browser></w3m-connecting-wc-browser>`;case'web':return o.html`<w3m-connecting-wc-web></w3m-connecting-wc-web>`;case'desktop':return o.html`
          <w3m-connecting-wc-desktop .onRetry=${()=>this.initializeConnection(!0)}>
          </w3m-connecting-wc-desktop>
        `;case'mobile':return o.html`
          <w3m-connecting-wc-mobile isMobile .onRetry=${()=>this.initializeConnection(!0)}>
          </w3m-connecting-wc-mobile>
        `;case'qrcode':return o.html`<w3m-connecting-wc-qrcode ?basic=${this.basic}></w3m-connecting-wc-qrcode>`;default:return o.html`<w3m-connecting-wc-unsupported></w3m-connecting-wc-unsupported>`}}headerTemplate(){return this.platforms.length>1?o.html`
      <w3m-connecting-header
        .platforms=${this.platforms}
        .onSelectPlatfrom=${this.onSelectPlatform.bind(this)}
      >
      </w3m-connecting-header>
    `:null}async onSelectPlatform(t){const o=this.shadowRoot?.querySelector('div');o&&(await o.animate([{opacity:1},{opacity:0}],{duration:200,fill:'forwards',easing:'ease'}).finished,this.platform=t,o.animate([{opacity:0},{opacity:1}],{duration:200,fill:'forwards',easing:'ease'}))}};h.styles=c.default,p([(0,n.state)()],h.prototype,"platform",void 0),p([(0,n.state)()],h.prototype,"platforms",void 0),p([(0,n.state)()],h.prototype,"isSiwxEnabled",void 0),p([(0,n.state)()],h.prototype,"remoteFeatures",void 0),p([(0,n.property)({type:Boolean})],h.prototype,"displayBranding",void 0),p([(0,n.property)({type:Boolean})],h.prototype,"basic",void 0),e.W3mConnectingWcView=h=p([(0,l.customElement)('w3m-connecting-wc-view')],h)},5996,[2,4553,4574,4456,4532,4550,4564,5997,6003,6015,6016,6017,6051,6052,6053]);
__d(function(g,_r,_i,a,m,e,_d){Object.defineProperty(e,"__esModule",{value:!0}),e.W3mConnectingHeader=void 0;var t=_r(_d[0]),o=_r(_d[1]),r=_r(_d[2]);_r(_d[3]),_r(_d[4]);var n=this&&this.__decorate||function(t,o,r,n){var l,s=arguments.length,i=s<3?o:null===n?n=Object.getOwnPropertyDescriptor(o,r):n;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)i=Reflect.decorate(t,o,r,n);else for(var c=t.length-1;c>=0;c--)(l=t[c])&&(i=(s<3?l(i):s>3?l(o,r,i):l(o,r))||i);return s>3&&i&&Object.defineProperty(o,r,i),i};let l=e.W3mConnectingHeader=class extends t.LitElement{constructor(){super(...arguments),this.platformTabs=[],this.unsubscribe=[],this.platforms=[],this.onSelectPlatfrom=void 0}disconnectCallback(){this.unsubscribe.forEach(t=>t())}render(){const o=this.generateTabs();return t.html`
      <wui-flex justifyContent="center" .padding=${['0','0','4','0']}>
        <wui-tabs .tabs=${o} .onTabChange=${this.onTabChange.bind(this)}></wui-tabs>
      </wui-flex>
    `}generateTabs(){const t=this.platforms.map(t=>'browser'===t?{label:'Browser',icon:'extension',platform:'browser'}:'mobile'===t?{label:'Mobile',icon:'mobile',platform:'mobile'}:'qrcode'===t?{label:'Mobile',icon:'mobile',platform:'qrcode'}:'web'===t?{label:'Webapp',icon:'browser',platform:'web'}:'desktop'===t?{label:'Desktop',icon:'desktop',platform:'desktop'}:{label:'Browser',icon:'extension',platform:'unsupported'});return this.platformTabs=t.map(({platform:t})=>t),t}onTabChange(t){const o=this.platformTabs[t];o&&this.onSelectPlatfrom?.(o)}};n([(0,o.property)({type:Array})],l.prototype,"platforms",void 0),n([(0,o.property)()],l.prototype,"onSelectPlatfrom",void 0),e.W3mConnectingHeader=l=n([(0,r.customElement)('w3m-connecting-header')],l)},5997,[4553,4574,4550,4585,5998]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0});var n=r(d[0]);Object.keys(n).forEach(function(t){"default"!==t&&"__esModule"!==t&&(t in e&&e[t]===n[t]||Object.defineProperty(e,t,{enumerable:!0,get:function(){return n[t]}}))})},5998,[5999]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.WuiTabs=void 0;var i=_r(_d[1]),s=_r(_d[2]),o=_r(_d[3]),r=_r(_d[4]);_r(_d[5]);var n=t(_r(_d[6])),c=this&&this.__decorate||function(t,i,s,o){var r,n=arguments.length,c=n<3?i:null===o?o=Object.getOwnPropertyDescriptor(i,s):o;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)c=Reflect.decorate(t,i,s,o);else for(var l=t.length-1;l>=0;l--)(r=t[l])&&(c=(n<3?r(c):n>3?r(i,s,c):r(i,s))||c);return n>3&&c&&Object.defineProperty(i,s,c),c};let l=e.WuiTabs=class extends i.LitElement{constructor(){super(...arguments),this.tabs=[],this.onTabChange=()=>null,this.size='md',this.activeTab=0}render(){return this.dataset.size=this.size,this.tabs.map((t,s)=>{const o=s===this.activeTab;return i.html`
        <wui-tab-item
          @click=${()=>this.onTabClick(s)}
          icon=${t.icon}
          size=${this.size}
          label=${t.label}
          ?active=${o}
          data-active=${o}
          data-testid="tab-${t.label?.toLowerCase()}"
        ></wui-tab-item>
      `})}onTabClick(t){this.activeTab=t,this.onTabChange(t)}};l.styles=[o.resetStyles,o.elementStyles,n.default],c([(0,s.property)({type:Array})],l.prototype,"tabs",void 0),c([(0,s.property)()],l.prototype,"onTabChange",void 0),c([(0,s.property)()],l.prototype,"size",void 0),c([(0,s.state)()],l.prototype,"activeTab",void 0),e.WuiTabs=l=c([(0,r.customElement)('wui-tabs')],l)},5999,[2,4553,4574,4552,4563,6000,6002]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.WuiTab=void 0;var i=_r(_d[1]),o=_r(_d[2]);_r(_d[3]),_r(_d[4]);var r=_r(_d[5]),s=_r(_d[6]),l=t(_r(_d[7])),n=this&&this.__decorate||function(t,i,o,r){var s,l=arguments.length,n=l<3?i:null===r?r=Object.getOwnPropertyDescriptor(i,o):r;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)n=Reflect.decorate(t,i,o,r);else for(var c=t.length-1;c>=0;c--)(s=t[c])&&(n=(l<3?s(n):l>3?s(i,o,n):s(i,o))||n);return l>3&&n&&Object.defineProperty(i,o,n),n};const c={lg:'lg-regular',md:'md-regular',sm:'sm-regular'},u={lg:'md',md:'sm',sm:'sm'};let p=e.WuiTab=class extends i.LitElement{constructor(){super(...arguments),this.icon='mobile',this.size='md',this.label='',this.active=!1}render(){return i.html`
      <button data-active=${this.active}>
        ${this.icon?i.html`<wui-icon size=${u[this.size]} name=${this.icon}></wui-icon>`:''}
        <wui-text variant=${c[this.size]}> ${this.label} </wui-text>
      </button>
    `}};p.styles=[r.resetStyles,r.elementStyles,l.default],n([(0,o.property)()],p.prototype,"icon",void 0),n([(0,o.property)()],p.prototype,"size",void 0),n([(0,o.property)()],p.prototype,"label",void 0),n([(0,o.property)({type:Boolean})],p.prototype,"active",void 0),e.WuiTab=p=n([(0,s.customElement)('wui-tab-item')],p)},6000,[2,4553,4574,4592,4622,4552,4563,6001]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var t=r(d[0]);e.default=t.css`
  :host {
    flex: 1;
    height: 100%;
  }

  button {
    width: 100%;
    height: 100%;
    display: inline-flex;
    align-items: center;
    padding: ${({spacing:t})=>t[1]} ${({spacing:t})=>t[2]};
    column-gap: ${({spacing:t})=>t[1]};
    color: ${({tokens:t})=>t.theme.textSecondary};
    border-radius: ${({borderRadius:t})=>t[20]};
    background-color: transparent;
    transition: background-color ${({durations:t})=>t.lg}
      ${({easings:t})=>t['ease-out-power-2']};
    will-change: background-color;
  }

  /* -- Hover & Active states ----------------------------------------------------------- */
  button[data-active='true'] {
    color: ${({tokens:t})=>t.theme.textPrimary};
    background-color: ${({tokens:t})=>t.theme.foregroundTertiary};
  }

  button:hover:enabled:not([data-active='true']),
  button:active:enabled:not([data-active='true']) {
    wui-text,
    wui-icon {
      color: ${({tokens:t})=>t.theme.textPrimary};
    }
  }
`},6001,[4559]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var o=r(d[0]);e.default=o.css`
  :host {
    display: inline-flex;
    align-items: center;
    background-color: ${({tokens:o})=>o.theme.foregroundSecondary};
    border-radius: ${({borderRadius:o})=>o[32]};
    padding: ${({spacing:o})=>o['01']};
    box-sizing: border-box;
  }

  :host([data-size='sm']) {
    height: 26px;
  }

  :host([data-size='md']) {
    height: 36px;
  }
`},6002,[4559]);
__d(function(g,_r,_i,a,m,e,_d){Object.defineProperty(e,"__esModule",{value:!0}),e.W3mConnectingWcBrowser=void 0;var t=_r(_d[0]),n=_r(_d[1]),o=_r(_d[2]),r=_r(_d[3]),s=this&&this.__decorate||function(t,n,o,r){var s,c=arguments.length,i=c<3?n:null===r?r=Object.getOwnPropertyDescriptor(n,o):r;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)i=Reflect.decorate(t,n,o,r);else for(var l=t.length-1;l>=0;l--)(s=t[l])&&(i=(c<3?s(i):c>3?s(n,o,i):s(n,o))||i);return c>3&&i&&Object.defineProperty(n,o,i),i};let c=e.W3mConnectingWcBrowser=class extends r.W3mConnectingWidget{constructor(){if(super(),!this.wallet)throw new Error('w3m-connecting-wc-browser: No wallet provided');this.onConnect=this.onConnectProxy.bind(this),this.onAutoConnect=this.onConnectProxy.bind(this),n.EventsController.sendEvent({type:'track',event:'SELECT_WALLET',properties:{name:this.wallet.name,platform:'browser',displayIndex:this.wallet?.display_index,walletRank:this.wallet.order,view:n.RouterController.state.view}})}async onConnectProxy(){try{this.error=!1;const{connectors:t}=n.ConnectorController.state,o=t.find(t=>'ANNOUNCED'===t.type&&t.info?.rdns===this.wallet?.rdns||'INJECTED'===t.type||t.name===this.wallet?.name);if(!o)throw new Error('w3m-connecting-wc-browser: No connector found');await n.ConnectionController.connectExternal(o,o.chain),n.ModalController.close()}catch(o){o instanceof n.AppKitError&&o.originalName===t.ErrorUtil.PROVIDER_RPC_ERROR_NAME.USER_REJECTED_REQUEST?n.EventsController.sendEvent({type:'track',event:'USER_REJECTED',properties:{message:o.message}}):n.EventsController.sendEvent({type:'track',event:'CONNECT_ERROR',properties:{message:o?.message??'Unknown'}}),this.error=!0}}};e.W3mConnectingWcBrowser=c=s([(0,o.customElement)('w3m-connecting-wc-browser')],c)},6003,[4456,4532,4550,6004]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.W3mConnectingWidget=void 0;var i=_r(_d[1]),o=_r(_d[2]),r=_r(_d[3]),n=_r(_d[4]);_r(_d[5]),_r(_d[6]),_r(_d[7]),_r(_d[8]),_r(_d[9]),_r(_d[10]),_r(_d[11]),_r(_d[12]),_r(_d[13]);var s=t(_r(_d[14])),l=this&&this.__decorate||function(t,i,o,r){var n,s=arguments.length,l=s<3?i:null===r?r=Object.getOwnPropertyDescriptor(i,o):r;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)l=Reflect.decorate(t,i,o,r);else for(var c=t.length-1;c>=0;c--)(n=t[c])&&(l=(s<3?n(l):s>3?n(i,o,l):n(i,o))||l);return s>3&&l&&Object.defineProperty(i,o,l),l};class c extends i.LitElement{constructor(){super(),this.wallet=n.RouterController.state.data?.wallet,this.connector=n.RouterController.state.data?.connector,this.timeout=void 0,this.secondaryBtnIcon='refresh',this.onConnect=void 0,this.onRender=void 0,this.onAutoConnect=void 0,this.isWalletConnect=!0,this.unsubscribe=[],this.imageSrc=n.AssetUtil.getConnectorImage(this.connector)??n.AssetUtil.getWalletImage(this.wallet),this.name=this.wallet?.name??this.connector?.name??'Wallet',this.isRetrying=!1,this.uri=n.ConnectionController.state.wcUri,this.error=n.ConnectionController.state.wcError,this.ready=!1,this.showRetry=!1,this.label=void 0,this.secondaryBtnLabel='Try again',this.secondaryLabel='Accept connection request in the wallet',this.isLoading=!1,this.isMobile=!1,this.onRetry=void 0,this.unsubscribe.push(n.ConnectionController.subscribeKey('wcUri',t=>{this.uri=t,this.isRetrying&&this.onRetry&&(this.isRetrying=!1,this.onConnect?.())}),n.ConnectionController.subscribeKey('wcError',t=>this.error=t)),(n.CoreHelperUtil.isTelegram()||n.CoreHelperUtil.isSafari())&&n.CoreHelperUtil.isIos()&&n.ConnectionController.state.wcUri&&this.onConnect?.()}firstUpdated(){this.onAutoConnect?.(),this.showRetry=!this.onAutoConnect}disconnectedCallback(){this.unsubscribe.forEach(t=>t()),n.ConnectionController.setWcError(!1),clearTimeout(this.timeout)}render(){this.onRender?.(),this.onShowRetry();const t=this.error?'Connection can be declined if a previous request is still active':this.secondaryLabel;let o='';return this.label?o=this.label:(o=`Continue in ${this.name}`,this.error&&(o='Connection declined')),i.html`
      <wui-flex
        data-error=${(0,r.ifDefined)(this.error)}
        data-retry=${this.showRetry}
        flexDirection="column"
        alignItems="center"
        .padding=${['10','5','5','5']}
        gap="6"
      >
        <wui-flex gap="2" justifyContent="center" alignItems="center">
          <wui-wallet-image size="lg" imageSrc=${(0,r.ifDefined)(this.imageSrc)}></wui-wallet-image>

          ${this.error?null:this.loaderTemplate()}

          <wui-icon-box
            color="error"
            icon="close"
            size="sm"
            border
            borderColor="wui-color-bg-125"
          ></wui-icon-box>
        </wui-flex>

        <wui-flex flexDirection="column" alignItems="center" gap="6"> <wui-flex
          flexDirection="column"
          alignItems="center"
          gap="2"
          .padding=${['2','0','0','0']}
        >
          <wui-text align="center" variant="lg-medium" color=${this.error?'error':'primary'}>
            ${o}
          </wui-text>
          <wui-text align="center" variant="lg-regular" color="secondary">${t}</wui-text>
        </wui-flex>

        ${this.secondaryBtnLabel?i.html`
                <wui-button
                  variant="neutral-secondary"
                  size="md"
                  ?disabled=${this.isRetrying||this.isLoading}
                  @click=${this.onTryAgain.bind(this)}
                  data-testid="w3m-connecting-widget-secondary-button"
                >
                  <wui-icon
                    color="inherit"
                    slot="iconLeft"
                    name=${this.secondaryBtnIcon}
                  ></wui-icon>
                  ${this.secondaryBtnLabel}
                </wui-button>
              `:null}
      </wui-flex>

      ${this.isWalletConnect?i.html`
              <wui-flex .padding=${['0','5','5','5']} justifyContent="center">
                <wui-link
                  @click=${this.onCopyUri}
                  variant="secondary"
                  icon="copy"
                  data-testid="wui-link-copy"
                >
                  Copy link
                </wui-link>
              </wui-flex>
            `:null}

      <w3m-mobile-download-links .wallet=${this.wallet}></w3m-mobile-download-links></wui-flex>
      </wui-flex>
    `}onShowRetry(){if(this.error&&!this.showRetry){this.showRetry=!0;const t=this.shadowRoot?.querySelector('wui-button');t?.animate([{opacity:0},{opacity:1}],{fill:'forwards',easing:'ease'})}}onTryAgain(){n.ConnectionController.setWcError(!1),this.onRetry?(this.isRetrying=!0,this.onRetry?.()):this.onConnect?.()}loaderTemplate(){const t=n.ThemeController.state.themeVariables['--w3m-border-radius-master'],o=t?parseInt(t.replace('px',''),10):4;return i.html`<wui-loading-thumbnail radius=${9*o}></wui-loading-thumbnail>`}onCopyUri(){try{this.uri&&(n.CoreHelperUtil.copyToClopboard(this.uri),n.SnackController.showSuccess('Link copied'))}catch{n.SnackController.showError('Failed to copy')}}}e.W3mConnectingWidget=c,c.styles=s.default,l([(0,o.state)()],c.prototype,"isRetrying",void 0),l([(0,o.state)()],c.prototype,"uri",void 0),l([(0,o.state)()],c.prototype,"error",void 0),l([(0,o.state)()],c.prototype,"ready",void 0),l([(0,o.state)()],c.prototype,"showRetry",void 0),l([(0,o.state)()],c.prototype,"label",void 0),l([(0,o.state)()],c.prototype,"secondaryBtnLabel",void 0),l([(0,o.state)()],c.prototype,"secondaryLabel",void 0),l([(0,o.state)()],c.prototype,"isLoading",void 0),l([(0,o.property)({type:Boolean})],c.prototype,"isMobile",void 0),l([(0,o.property)()],c.prototype,"onRetry",void 0)},6004,[2,4553,4574,4588,4532,4638,4585,4643,6005,4644,6006,4647,4648,6009,6014]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0});var n=r(d[0]);Object.keys(n).forEach(function(t){"default"!==t&&"__esModule"!==t&&(t in e&&e[t]===n[t]||Object.defineProperty(e,t,{enumerable:!0,get:function(){return n[t]}}))})},6005,[4627]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0});var n=r(d[0]);Object.keys(n).forEach(function(t){"default"!==t&&"__esModule"!==t&&(t in e&&e[t]===n[t]||Object.defineProperty(e,t,{enumerable:!0,get:function(){return n[t]}}))})},6006,[6007]);
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
    `}};u.styles=[o.resetStyles,n.default],d([(0,i.property)({type:Number})],u.prototype,"radius",void 0),e.WuiLoadingThumbnail=u=d([(0,s.customElement)('wui-loading-thumbnail')],u)},6007,[2,4553,4574,4552,4563,6008]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var t=r(d[0]);e.default=t.css`
  :host {
    display: block;
    width: 100px;
    height: 100px;
  }

  svg {
    width: 100px;
    height: 100px;
  }

  rect {
    fill: none;
    stroke: ${t=>t.colors.accent100};
    stroke-width: 3px;
    stroke-linecap: round;
    animation: dash 1s linear infinite;
  }

  @keyframes dash {
    to {
      stroke-dashoffset: 0px;
    }
  }
`},6008,[4559]);
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
      `:(this.style.display='none',null)}onAppStore(){this.wallet?.app_store&&n.CoreHelperUtil.openHref(this.wallet.app_store,'_blank')}onPlayStore(){this.wallet?.play_store&&n.CoreHelperUtil.openHref(this.wallet.play_store,'_blank')}onHomePage(){this.wallet?.homepage&&n.CoreHelperUtil.openHref(this.wallet.homepage,'_blank')}};c.styles=[r.default],s([(0,o.property)({type:Object})],c.prototype,"wallet",void 0),e.W3mMobileDownloadLinks=c=s([(0,i.customElement)('w3m-mobile-download-links')],c)},6009,[2,4553,4574,4532,4550,6010,6013]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0});var n=r(d[0]);Object.keys(n).forEach(function(t){"default"!==t&&"__esModule"!==t&&(t in e&&e[t]===n[t]||Object.defineProperty(e,t,{enumerable:!0,get:function(){return n[t]}}))})},6010,[6011]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.WuiCtaButton=void 0;var o=_r(_d[1]),i=_r(_d[2]);_r(_d[3]),_r(_d[4]),_r(_d[5]);var r=_r(_d[6]),n=_r(_d[7]);_r(_d[8]);var l=t(_r(_d[9])),u=this&&this.__decorate||function(t,o,i,r){var n,l=arguments.length,u=l<3?o:null===r?r=Object.getOwnPropertyDescriptor(o,i):r;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)u=Reflect.decorate(t,o,i,r);else for(var s=t.length-1;s>=0;s--)(n=t[s])&&(u=(l<3?n(u):l>3?n(o,i,u):n(o,i))||u);return l>3&&u&&Object.defineProperty(o,i,u),u};let s=e.WuiCtaButton=class extends o.LitElement{constructor(){super(...arguments),this.disabled=!1,this.label='',this.buttonLabel=''}render(){return o.html`
      <wui-flex justifyContent="space-between" alignItems="center">
        <wui-text variant="lg-regular" color="inherit">${this.label}</wui-text>
        <wui-button variant="accent-secondary" size="sm">
          ${this.buttonLabel}
          <wui-icon name="chevronRight" color="inherit" size="inherit" slot="iconRight"></wui-icon>
        </wui-button>
      </wui-flex>
    `}};s.styles=[r.resetStyles,r.elementStyles,l.default],u([(0,i.property)({type:Boolean})],s.prototype,"disabled",void 0),u([(0,i.property)()],s.prototype,"label",void 0),u([(0,i.property)()],s.prototype,"buttonLabel",void 0),e.WuiCtaButton=s=u([(0,n.customElement)('wui-cta-button')],s)},6011,[2,4553,4574,4592,4622,4586,4552,4563,4639,6012]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var t=r(d[0]);e.default=t.css`
  wui-flex {
    width: 100%;
    height: 52px;
    box-sizing: border-box;
    background-color: ${({tokens:t})=>t.theme.foregroundPrimary};
    border-radius: ${({borderRadius:t})=>t[5]};
    padding-left: ${({spacing:t})=>t[3]};
    padding-right: ${({spacing:t})=>t[3]};
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: ${({spacing:t})=>t[6]};
  }

  wui-text {
    color: ${({tokens:t})=>t.theme.textSecondary};
  }

  wui-icon {
    width: 12px;
    height: 12px;
  }
`},6012,[4559]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var s=r(d[0]);e.default=s.css`
  :host {
    display: block;
    padding: 0 ${({spacing:s})=>s[5]} ${({spacing:s})=>s[5]};
  }
`},6013,[4550]);
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

  wui-wallet-image {
    width: 56px;
    height: 56px;
  }

  wui-loading-thumbnail {
    position: absolute;
  }

  wui-icon-box {
    position: absolute;
    right: calc(${({spacing:t})=>t[1]} * -1);
    bottom: calc(${({spacing:t})=>t[1]} * -1);
    opacity: 0;
    transform: scale(0.5);
    transition-property: opacity, transform;
    transition-duration: ${({durations:t})=>t.lg};
    transition-timing-function: ${({easings:t})=>t['ease-out-power-2']};
    will-change: opacity, transform;
  }

  wui-text[align='center'] {
    width: 100%;
    padding: 0px ${({spacing:t})=>t[4]};
  }

  [data-error='true'] wui-icon-box {
    opacity: 1;
    transform: scale(1);
  }

  [data-error='true'] > wui-flex:first-child {
    animation: shake 250ms ${({easings:t})=>t['ease-out-power-2']} both;
  }

  [data-retry='false'] wui-link {
    display: none;
  }

  [data-retry='true'] wui-link {
    display: block;
    opacity: 1;
  }

  w3m-mobile-download-links {
    padding: 0px;
    width: 100%;
  }
`},6014,[4550]);
__d(function(g,_r,_i,a,m,e,_d){Object.defineProperty(e,"__esModule",{value:!0}),e.W3mConnectingWcDesktop=void 0;var t=_r(_d[0]),n=_r(_d[1]),o=_r(_d[2]),r=this&&this.__decorate||function(t,n,o,r){var i,l=arguments.length,s=l<3?n:null===r?r=Object.getOwnPropertyDescriptor(n,o):r;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)s=Reflect.decorate(t,n,o,r);else for(var c=t.length-1;c>=0;c--)(i=t[c])&&(s=(l<3?i(s):l>3?i(n,o,s):i(n,o))||s);return l>3&&s&&Object.defineProperty(n,o,s),s};let i=e.W3mConnectingWcDesktop=class extends o.W3mConnectingWidget{constructor(){if(super(),!this.wallet)throw new Error('w3m-connecting-wc-desktop: No wallet provided');this.onConnect=this.onConnectProxy.bind(this),this.onRender=this.onRenderProxy.bind(this),t.EventsController.sendEvent({type:'track',event:'SELECT_WALLET',properties:{name:this.wallet.name,platform:'desktop',displayIndex:this.wallet?.display_index,walletRank:this.wallet.order,view:t.RouterController.state.view}})}onRenderProxy(){!this.ready&&this.uri&&(this.ready=!0,this.onConnect?.())}onConnectProxy(){if(this.wallet?.desktop_link&&this.uri)try{this.error=!1;const{desktop_link:n,name:o}=this.wallet,{redirect:r,href:i}=t.CoreHelperUtil.formatNativeUrl(n,this.uri);t.ConnectionController.setWcLinking({name:o,href:i}),t.ConnectionController.setRecentWallet(this.wallet),t.CoreHelperUtil.openHref(r,'_blank')}catch{this.error=!0}}};e.W3mConnectingWcDesktop=i=r([(0,n.customElement)('w3m-connecting-wc-desktop')],i)},6015,[4532,4550,6004]);
__d(function(g,_r,_i,a,m,e,_d){Object.defineProperty(e,"__esModule",{value:!0}),e.W3mConnectingWcMobile=void 0;var t=_r(_d[0]),n=_r(_d[1]),i=_r(_d[2]),o=_r(_d[3]),r=this&&this.__decorate||function(t,n,i,o){var r,s=arguments.length,l=s<3?n:null===o?o=Object.getOwnPropertyDescriptor(n,i):o;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)l=Reflect.decorate(t,n,i,o);else for(var c=t.length-1;c>=0;c--)(r=t[c])&&(l=(s<3?r(l):s>3?r(n,i,l):r(n,i))||l);return s>3&&l&&Object.defineProperty(n,i,l),l};let s=e.W3mConnectingWcMobile=class extends o.W3mConnectingWidget{constructor(){if(super(),this.btnLabelTimeout=void 0,this.redirectDeeplink=void 0,this.redirectUniversalLink=void 0,this.target=void 0,this.preferUniversalLinks=n.OptionsController.state.experimental_preferUniversalLinks,this.isLoading=!0,this.onConnect=()=>{n.ConnectionControllerUtil.onConnectMobile(this.wallet)},!this.wallet)throw new Error('w3m-connecting-wc-mobile: No wallet provided');this.secondaryBtnLabel='Open',this.secondaryLabel=n.ConstantsUtil.CONNECT_LABELS.MOBILE,this.secondaryBtnIcon='externalLink',this.onHandleURI(),this.unsubscribe.push(n.ConnectionController.subscribeKey('wcUri',()=>{this.onHandleURI()})),n.EventsController.sendEvent({type:'track',event:'SELECT_WALLET',properties:{name:this.wallet.name,platform:'mobile',displayIndex:this.wallet?.display_index,walletRank:this.wallet.order,view:n.RouterController.state.view}})}disconnectedCallback(){super.disconnectedCallback(),clearTimeout(this.btnLabelTimeout)}onHandleURI(){this.isLoading=!this.uri,!this.ready&&this.uri&&(this.ready=!0,this.onConnect?.())}onTryAgain(){n.ConnectionController.setWcError(!1),this.onConnect?.()}};r([(0,t.state)()],s.prototype,"redirectDeeplink",void 0),r([(0,t.state)()],s.prototype,"redirectUniversalLink",void 0),r([(0,t.state)()],s.prototype,"target",void 0),r([(0,t.state)()],s.prototype,"preferUniversalLinks",void 0),r([(0,t.state)()],s.prototype,"isLoading",void 0),e.W3mConnectingWcMobile=s=r([(0,i.customElement)('w3m-connecting-wc-mobile')],s)},6016,[4574,4532,4550,6004]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.W3mConnectingWcQrcode=void 0;var i=_r(_d[1]),o=_r(_d[2]),r=_r(_d[3]),n=_r(_d[4]),l=_r(_d[5]);_r(_d[6]),_r(_d[7]),_r(_d[8]),_r(_d[9]),_r(_d[10]),_r(_d[11]),_r(_d[12]);var s=_r(_d[13]);_r(_d[14]);var c=t(_r(_d[15])),d=this&&this.__decorate||function(t,i,o,r){var n,l=arguments.length,s=l<3?i:null===r?r=Object.getOwnPropertyDescriptor(i,o):r;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)s=Reflect.decorate(t,i,o,r);else for(var c=t.length-1;c>=0;c--)(n=t[c])&&(s=(l<3?n(s):l>3?n(i,o,s):n(i,o))||s);return l>3&&s&&Object.defineProperty(i,o,s),s};let h=e.W3mConnectingWcQrcode=class extends s.W3mConnectingWidget{constructor(){super(),this.basic=!1}firstUpdated(){this.basic||n.EventsController.sendEvent({type:'track',event:'SELECT_WALLET',properties:{name:this.wallet?.name??'WalletConnect',platform:'qrcode',displayIndex:this.wallet?.display_index,walletRank:this.wallet?.order,view:n.RouterController.state.view}})}disconnectedCallback(){super.disconnectedCallback(),this.unsubscribe?.forEach(t=>t())}render(){return this.onRenderProxy(),i.html`
      <wui-flex
        flexDirection="column"
        alignItems="center"
        .padding=${['0','5','5','5']}
        gap="5"
      >
        <wui-shimmer width="100%"> ${this.qrCodeTemplate()} </wui-shimmer>
        <wui-text variant="lg-medium" color="primary"> Scan this QR Code with your phone </wui-text>
        ${this.copyTemplate()}
      </wui-flex>
      <w3m-mobile-download-links .wallet=${this.wallet}></w3m-mobile-download-links>
    `}onRenderProxy(){!this.ready&&this.uri&&(this.ready=!0)}qrCodeTemplate(){if(!this.uri||!this.ready)return null;const t=this.wallet?this.wallet.name:void 0;n.ConnectionController.setWcLinking(void 0),n.ConnectionController.setRecentWallet(this.wallet);const o=n.ThemeController.state.themeVariables['--apkt-qr-color']??n.ThemeController.state.themeVariables['--w3m-qr-color'];return i.html` <wui-qr-code
      theme=${n.ThemeController.state.themeMode}
      uri=${this.uri}
      imageSrc=${(0,r.ifDefined)(n.AssetUtil.getWalletImage(this.wallet))}
      color=${(0,r.ifDefined)(o)}
      alt=${(0,r.ifDefined)(t)}
      data-testid="wui-qr-code"
    ></wui-qr-code>`}copyTemplate(){const t=!this.uri||!this.ready;return i.html`<wui-button
      .disabled=${t}
      @click=${this.onCopyUri}
      variant="neutral-secondary"
      size="sm"
      data-testid="copy-wc2-uri"
    >
      Copy link
      <wui-icon size="sm" color="inherit" name="copy" slot="iconRight"></wui-icon>
    </wui-button>`}};h.styles=c.default,d([(0,o.property)({type:Boolean})],h.prototype,"basic",void 0),e.W3mConnectingWcQrcode=h=d([(0,l.customElement)('w3m-connecting-wc-qrcode')],h)},6017,[2,4553,4574,4588,4532,4550,4585,4643,4644,6018,4649,4647,4652,6004,6009,6050]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0});var n=r(d[0]);Object.keys(n).forEach(function(t){"default"!==t&&"__esModule"!==t&&(t in e&&e[t]===n[t]||Object.defineProperty(e,t,{enumerable:!0,get:function(){return n[t]}}))})},6018,[6019]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.WuiQrCode=void 0;var i=_r(_d[1]),r=_r(_d[2]);_r(_d[3]),_r(_d[4]),_r(_d[5]);var o=_r(_d[6]),s=_r(_d[7]),l=_r(_d[8]),n=t(_r(_d[9])),h=this&&this.__decorate||function(t,i,r,o){var s,l=arguments.length,n=l<3?i:null===o?o=Object.getOwnPropertyDescriptor(i,r):o;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)n=Reflect.decorate(t,i,r,o);else for(var h=t.length-1;h>=0;h--)(s=t[h])&&(n=(l<3?s(n):l>3?s(i,r,n):s(i,r))||n);return l>3&&n&&Object.defineProperty(i,r,n),n};let c=e.WuiQrCode=class extends i.LitElement{constructor(){super(...arguments),this.uri='',this.size=500,this.theme='dark',this.imageSrc=void 0,this.alt=void 0,this.arenaClear=void 0,this.farcaster=void 0}render(){return this.dataset.theme=this.theme,this.dataset.clear=String(this.arenaClear),i.html`<wui-flex
      alignItems="center"
      justifyContent="center"
      class="wui-qr-code"
      direction="column"
      gap="4"
      width="100%"
      style="height: 100%"
    >
      ${this.templateVisual()} ${this.templateSvg()}
    </wui-flex>`}templateSvg(){return i.svg`
      <svg viewBox="0 0 ${this.size} ${this.size}" width="100%" height="100%">
        ${o.QrCodeUtil.generate({uri:this.uri,size:this.size,logoSize:this.arenaClear?0:this.size/4})}
      </svg>
    `}templateVisual(){return this.imageSrc?i.html`<wui-image src=${this.imageSrc} alt=${this.alt??'logo'}></wui-image>`:this.farcaster?i.html`<wui-icon
        class="farcaster"
        size="inherit"
        color="inherit"
        name="farcaster"
      ></wui-icon>`:i.html`<wui-icon size="inherit" color="inherit" name="walletConnect"></wui-icon>`}};c.styles=[s.resetStyles,n.default],h([(0,r.property)()],c.prototype,"uri",void 0),h([(0,r.property)({type:Number})],c.prototype,"size",void 0),h([(0,r.property)()],c.prototype,"theme",void 0),h([(0,r.property)()],c.prototype,"imageSrc",void 0),h([(0,r.property)()],c.prototype,"alt",void 0),h([(0,r.property)({type:Boolean})],c.prototype,"arenaClear",void 0),h([(0,r.property)({type:Boolean})],c.prototype,"farcaster",void 0),e.WuiQrCode=c=h([(0,l.customElement)('wui-qr-code')],c)},6019,[2,4553,4574,4592,4631,4586,6020,4552,4563,6049]);
__d(function(g,r,_i,_a,m,e,d){var t=r(d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.QrCodeUtil=void 0;var o=t(r(d[1])),n=r(d[2]);function c(t,o,n){if(t===o)return!1;return(t-o<0?o-t:t-o)<=n+.1}function s(t,n){const c=Array.prototype.slice.call(o.default.create(t,{errorCorrectionLevel:n}).modules.data,0),s=Math.sqrt(c.length);return c.reduce((t,o,n)=>(n%s===0?t.push([o]):t[t.length-1].push(o))&&t,[])}e.QrCodeUtil={generate({uri:t,size:o,logoSize:l,padding:h=8,dotColor:a="var(--apkt-colors-black)"}){const i=[],u=s(t,'Q'),f=(o-2*h)/u.length,p=[{x:0,y:0},{x:1,y:0},{x:0,y:1}];p.forEach(({x:t,y:o})=>{const c=(u.length-7)*f*t+h,s=(u.length-7)*f*o+h,l=.45;for(let t=0;t<p.length;t+=1){const o=f*(7-2*t);i.push(n.svg`
            <rect
              fill=${2===t?'var(--apkt-colors-black)':'var(--apkt-colors-white)'}
              width=${0===t?o-10:o}
              rx= ${0===t?(o-10)*l:o*l}
              ry= ${0===t?(o-10)*l:o*l}
              stroke=${a}
              stroke-width=${0===t?10:0}
              height=${0===t?o-10:o}
              x= ${0===t?s+f*t+5:s+f*t}
              y= ${0===t?c+f*t+5:c+f*t}
            />
          `)}});const $=Math.floor((l+25)/f),y=u.length/2-$/2,v=u.length/2+$/2-1,k=[];u.forEach((t,o)=>{t.forEach((t,n)=>{if(u[o][n]&&!(o<7&&n<7||o>u.length-8&&n<7||o<7&&n>u.length-8||o>y&&o<v&&n>y&&n<v)){const t=o*f+f/2+h,c=n*f+f/2+h;k.push([t,c])}})});const x={};return k.forEach(([t,o])=>{x[t]?x[t]?.push(o):x[t]=[o]}),Object.entries(x).map(([t,o])=>{const n=o.filter(t=>o.every(o=>!c(t,o,f)));return[Number(t),n]}).forEach(([t,o])=>{o.forEach(o=>{i.push(n.svg`<circle cx=${t} cy=${o} fill=${a} r=${f/2.5} />`)})}),Object.entries(x).filter(([t,o])=>o.length>1).map(([t,o])=>{const n=o.filter(t=>o.some(o=>c(t,o,f)));return[Number(t),n]}).map(([t,o])=>{o.sort((t,o)=>t<o?-1:1);const n=[];for(const t of o){const o=n.find(o=>o.some(o=>c(t,o,f)));o?o.push(t):n.push([t])}return[t,n.map(t=>[t[0],t[t.length-1]])]}).forEach(([t,o])=>{o.forEach(([o,c])=>{i.push(n.svg`
              <line
                x1=${t}
                x2=${t}
                y1=${o}
                y2=${c}
                stroke=${a}
                stroke-width=${f/1.25}
                stroke-linecap="round"
              />
            `)})}),i}}},6020,[2,6021,4553]);
__d(function(g,r,i,a,m,_e,d){const t=r(d[0]),n=r(d[1]),e=r(d[2]),o=r(d[3]);function c(e,o,c,l,u){const f=[].slice.call(arguments,1),s=f.length,v='function'==typeof f[s-1];if(!v&&!t())throw new Error('Callback required as last argument');if(!v){if(s<1)throw new Error('Too few arguments provided');return 1===s?(c=o,o=l=void 0):2!==s||o.getContext||(l=c,c=o,o=void 0),new Promise(function(t,u){try{const u=n.create(c,l);t(e(u,o,l))}catch(t){u(t)}})}if(s<2)throw new Error('Too few arguments provided');2===s?(u=c,c=o,o=l=void 0):3===s&&(o.getContext&&void 0===u?(u=l,l=void 0):(u=l,l=c,c=o,o=void 0));try{const t=n.create(c,l);u(null,e(t,o,l))}catch(t){u(t)}}_e.create=n.create,_e.toCanvas=c.bind(null,e.render),_e.toDataURL=c.bind(null,e.renderToDataURL),_e.toString=c.bind(null,function(t,n,e){return o.render(t,e)})},6021,[6022,6023,6046,6048]);
__d(function(g,r,i,a,m,e,d){m.exports=function(){return'function'==typeof Promise&&Promise.prototype&&Promise.prototype.then}},6022,[]);
__d(function(g,_r,_i,a,m,e,d){const t=_r(d[0]),o=_r(d[1]),n=_r(d[2]),r=_r(d[3]),s=_r(d[4]),i=_r(d[5]),f=_r(d[6]),c=_r(d[7]),l=_r(d[8]),u=_r(d[9]),h=_r(d[10]),w=_r(d[11]),C=_r(d[12]);function y(t,o){const n=t.size,r=i.getPositions(o);for(let o=0;o<r.length;o++){const s=r[o][0],i=r[o][1];for(let o=-1;o<=7;o++)if(!(s+o<=-1||n<=s+o))for(let r=-1;r<=7;r++)i+r<=-1||n<=i+r||(o>=0&&o<=6&&(0===r||6===r)||r>=0&&r<=6&&(0===o||6===o)||o>=2&&o<=4&&r>=2&&r<=4?t.set(s+o,i+r,!0,!0):t.set(s+o,i+r,!1,!0))}}function S(t){const o=t.size;for(let n=8;n<o-8;n++){const o=n%2==0;t.set(n,6,o,!0),t.set(6,n,o,!0)}}function p(t,o){const n=s.getPositions(o);for(let o=0;o<n.length;o++){const r=n[o][0],s=n[o][1];for(let o=-2;o<=2;o++)for(let n=-2;n<=2;n++)-2===o||2===o||-2===n||2===n||0===o&&0===n?t.set(r+o,s+n,!0,!0):t.set(r+o,s+n,!1,!0)}}function v(t,o){const n=t.size,r=u.getEncodedBits(o);let s,i,f;for(let o=0;o<18;o++)s=Math.floor(o/3),i=o%3+n-8-3,f=1==(r>>o&1),t.set(s,i,f,!0),t.set(i,s,f,!0)}function B(t,o,n){const r=t.size,s=h.getEncodedBits(o,n);let i,f;for(i=0;i<15;i++)f=1==(s>>i&1),i<6?t.set(i,8,f,!0):i<8?t.set(i+1,8,f,!0):t.set(r-15+i,8,f,!0),i<8?t.set(8,r-i-1,f,!0):i<9?t.set(8,15-i-1+1,f,!0):t.set(8,15-i-1,f,!0);t.set(r-8,8,1,!0)}function b(t,o){const n=t.size;let r=-1,s=n-1,i=7,f=0;for(let c=n-1;c>0;c-=2)for(6===c&&c--;;){for(let n=0;n<2;n++)if(!t.isReserved(s,c-n)){let r=!1;f<o.length&&(r=1==(o[f]>>>i&1)),t.set(s,c-n,r),i--,-1===i&&(f++,i=7)}if(s+=r,s<0||n<=s){s-=r,r=-r;break}}}function M(o,r,s){const i=new n;s.forEach(function(t){i.put(t.mode.bit,4),i.put(t.getLength(),w.getCharCountIndicator(t.mode,o)),t.write(i)});const f=8*(t.getSymbolTotalCodewords(o)-c.getTotalCodewordsCount(o,r));for(i.getLengthInBits()+4<=f&&i.put(0,4);i.getLengthInBits()%8!=0;)i.putBit(0);const l=(f-i.getLengthInBits())/8;for(let t=0;t<l;t++)i.put(t%2?17:236,8);return I(i,o,r)}function I(o,n,r){const s=t.getSymbolTotalCodewords(n),i=s-c.getTotalCodewordsCount(n,r),f=c.getBlocksCount(n,r),u=f-s%f,h=Math.floor(s/f),w=Math.floor(i/f),C=w+1,y=h-w,S=new l(y);let p=0;const v=new Array(f),B=new Array(f);let b=0;const M=new Uint8Array(o.buffer);for(let t=0;t<f;t++){const o=t<u?w:C;v[t]=M.slice(p,p+o),B[t]=S.encode(v[t]),p+=o,b=Math.max(b,o)}const I=new Uint8Array(s);let A,E,T=0;for(A=0;A<b;A++)for(E=0;E<f;E++)A<v[E].length&&(I[T++]=v[E][A]);for(A=0;A<y;A++)for(E=0;E<f;E++)I[T++]=B[E][A];return I}function A(o,n,s,i){let c;if(Array.isArray(o))c=C.fromArray(o);else{if('string'!=typeof o)throw new Error('Invalid data');{let t=n;if(!t){const n=C.rawSplit(o);t=u.getBestVersionForData(n,s)}c=C.fromString(o,t||40)}}const l=u.getBestVersionForData(c,s);if(!l)throw new Error('The amount of data is too big to be stored in a QR Code');if(n){if(n<l)throw new Error("\nThe chosen QR Code version cannot contain this amount of data.\nMinimum version required to store current data is: "+l+'.\n')}else n=l;const h=M(n,s,c),w=t.getSymbolSize(n),I=new r(w);return y(I,n),S(I),p(I,n),B(I,s,0),n>=7&&v(I,n),b(I,h),isNaN(i)&&(i=f.getBestMask(I,B.bind(null,I,s))),f.applyMask(i,I),B(I,s,i),{modules:I,version:n,errorCorrectionLevel:s,maskPattern:i,segments:c}}e.create=function(n,r){if(void 0===n||''===n)throw new Error('No input text');let s,i,c=o.M;return void 0!==r&&(c=o.from(r.errorCorrectionLevel,o.M),s=u.from(r.version),i=f.from(r.maskPattern),r.toSJISFunc&&t.setToSJISFunction(r.toSJISFunc)),A(n,s,c,i)}},6023,[6024,6025,6026,6027,6028,6029,6030,6031,6032,6035,6039,6036,6040]);
__d(function(g,r,i,a,m,e,d){let n;const o=[0,26,44,70,100,134,172,196,242,292,346,404,466,532,581,655,733,815,901,991,1085,1156,1258,1364,1474,1588,1706,1828,1921,2051,2185,2323,2465,2611,2761,2876,3034,3196,3362,3532,3706];e.getSymbolSize=function(n){if(!n)throw new Error('"version" cannot be null or undefined');if(n<1||n>40)throw new Error('"version" should be in range from 1 to 40');return 4*n+17},e.getSymbolTotalCodewords=function(n){return o[n]},e.getBCHDigit=function(n){let o=0;for(;0!==n;)o++,n>>>=1;return o},e.setToSJISFunction=function(o){if('function'!=typeof o)throw new Error('"toSJISFunc" is not a valid function.');n=o},e.isKanjiModeEnabled=function(){return void 0!==n},e.toSJIS=function(o){return n(o)}},6024,[]);
__d(function(g,r,i,a,m,_e,d){function t(t){if('string'!=typeof t)throw new Error('Param is not a string');switch(t.toLowerCase()){case'l':case'low':return _e.L;case'm':case'medium':return _e.M;case'q':case'quartile':return _e.Q;case'h':case'high':return _e.H;default:throw new Error('Unknown EC Level: '+t)}}_e.L={bit:1},_e.M={bit:0},_e.Q={bit:3},_e.H={bit:2},_e.isValid=function(t){return t&&void 0!==t.bit&&t.bit>=0&&t.bit<4},_e.from=function(e,n){if(_e.isValid(e))return e;try{return t(e)}catch(t){return n}}},6025,[]);
__d(function(g,r,_i,a,m,e,d){function t(){this.buffer=[],this.length=0}t.prototype={get:function(t){const n=Math.floor(t/8);return 1==(this.buffer[n]>>>7-t%8&1)},put:function(t,n){for(let h=0;h<n;h++)this.putBit(1==(t>>>n-h-1&1))},getLengthInBits:function(){return this.length},putBit:function(t){const n=Math.floor(this.length/8);this.buffer.length<=n&&this.buffer.push(0),t&&(this.buffer[n]|=128>>>this.length%8),this.length++}},m.exports=t},6026,[]);
__d(function(g,r,i,a,m,e,d){function t(t){if(!t||t<1)throw new Error('BitMatrix size must be defined and greater than 0');this.size=t,this.data=new Uint8Array(t*t),this.reservedBit=new Uint8Array(t*t)}t.prototype.set=function(t,s,n,o){const h=t*this.size+s;this.data[h]=n,o&&(this.reservedBit[h]=!0)},t.prototype.get=function(t,s){return this.data[t*this.size+s]},t.prototype.xor=function(t,s,n){this.data[t*this.size+s]^=n},t.prototype.isReserved=function(t,s){return this.reservedBit[t*this.size+s]},m.exports=t},6027,[]);
__d(function(g,r,_i,a,m,e,d){const o=r(d[0]).getSymbolSize;e.getRowColCoords=function(t){if(1===t)return[];const n=Math.floor(t/7)+2,s=o(t),l=145===s?26:2*Math.ceil((s-13)/(2*n-2)),f=[s-7];for(let o=1;o<n-1;o++)f[o]=f[o-1]-l;return f.push(6),f.reverse()},e.getPositions=function(o){const t=[],n=e.getRowColCoords(o),s=n.length;for(let o=0;o<s;o++)for(let l=0;l<s;l++)0===o&&0===l||0===o&&l===s-1||o===s-1&&0===l||t.push([n[o],n[l]]);return t}},6028,[6024]);
__d(function(g,r,i,a,m,e,d){const n=r(d[0]).getSymbolSize;e.getPositions=function(t){const o=n(t);return[[0,0],[o-7,0],[0,o-7]]}},6029,[6024]);
__d(function(g,r,_i,a,m,e,d){e.Patterns={PATTERN000:0,PATTERN001:1,PATTERN010:2,PATTERN011:3,PATTERN100:4,PATTERN101:5,PATTERN110:6,PATTERN111:7};const t=3,n=3,s=40,l=10;function o(t,n,s){switch(t){case e.Patterns.PATTERN000:return(n+s)%2==0;case e.Patterns.PATTERN001:return n%2==0;case e.Patterns.PATTERN010:return s%3==0;case e.Patterns.PATTERN011:return(n+s)%3==0;case e.Patterns.PATTERN100:return(Math.floor(n/2)+Math.floor(s/3))%2==0;case e.Patterns.PATTERN101:return n*s%2+n*s%3==0;case e.Patterns.PATTERN110:return(n*s%2+n*s%3)%2==0;case e.Patterns.PATTERN111:return(n*s%3+(n+s)%2)%2==0;default:throw new Error('bad maskPattern:'+t)}}e.isValid=function(t){return null!=t&&''!==t&&!isNaN(t)&&t>=0&&t<=7},e.from=function(t){return e.isValid(t)?parseInt(t,10):void 0},e.getPenaltyN1=function(n){const s=n.size;let l=0,o=0,P=0,T=null,c=null;for(let u=0;u<s;u++){o=P=0,T=c=null;for(let N=0;N<s;N++){let s=n.get(u,N);s===T?o++:(o>=5&&(l+=t+(o-5)),T=s,o=1),s=n.get(N,u),s===c?P++:(P>=5&&(l+=t+(P-5)),c=s,P=1)}o>=5&&(l+=t+(o-5)),P>=5&&(l+=t+(P-5))}return l},e.getPenaltyN2=function(t){const s=t.size;let l=0;for(let n=0;n<s-1;n++)for(let o=0;o<s-1;o++){const s=t.get(n,o)+t.get(n,o+1)+t.get(n+1,o)+t.get(n+1,o+1);4!==s&&0!==s||l++}return l*n},e.getPenaltyN3=function(t){const n=t.size;let l=0,o=0,P=0;for(let s=0;s<n;s++){o=P=0;for(let T=0;T<n;T++)o=o<<1&2047|t.get(s,T),T>=10&&(1488===o||93===o)&&l++,P=P<<1&2047|t.get(T,s),T>=10&&(1488===P||93===P)&&l++}return l*s},e.getPenaltyN4=function(t){let n=0;const s=t.data.length;for(let l=0;l<s;l++)n+=t.data[l];return Math.abs(Math.ceil(100*n/s/5)-10)*l},e.applyMask=function(t,n){const s=n.size;for(let l=0;l<s;l++)for(let P=0;P<s;P++)n.isReserved(P,l)||n.xor(P,l,o(t,P,l))},e.getBestMask=function(t,n){const s=Object.keys(e.Patterns).length;let l=0,o=1/0;for(let P=0;P<s;P++){n(P),e.applyMask(P,t);const s=e.getPenaltyN1(t)+e.getPenaltyN2(t)+e.getPenaltyN3(t)+e.getPenaltyN4(t);e.applyMask(P,t),s<o&&(o=s,l=P)}return l}},6030,[]);
__d(function(g,r,i,a,m,e,d){const t=r(d[0]),n=[1,1,1,1,1,1,1,1,1,1,2,2,1,2,2,4,1,2,4,4,2,4,4,4,2,4,6,5,2,4,6,6,2,5,8,8,4,5,8,8,4,5,8,11,4,8,10,11,4,9,12,16,4,9,16,16,6,10,12,18,6,10,17,16,6,11,16,19,6,13,18,21,7,14,21,25,8,16,20,25,8,17,23,25,9,17,23,34,9,18,25,30,10,20,27,32,12,21,29,35,12,23,34,37,12,25,34,40,13,26,35,42,14,28,38,45,15,29,40,48,16,31,43,51,17,33,45,54,18,35,48,57,19,37,51,60,19,38,53,63,20,40,56,66,21,43,59,70,22,45,62,74,24,47,65,77,25,49,68,81],u=[7,10,13,17,10,16,22,28,15,26,36,44,20,36,52,64,26,48,72,88,36,64,96,112,40,72,108,130,48,88,132,156,60,110,160,192,72,130,192,224,80,150,224,264,96,176,260,308,104,198,288,352,120,216,320,384,132,240,360,432,144,280,408,480,168,308,448,532,180,338,504,588,196,364,546,650,224,416,600,700,224,442,644,750,252,476,690,816,270,504,750,900,300,560,810,960,312,588,870,1050,336,644,952,1110,360,700,1020,1200,390,728,1050,1260,420,784,1140,1350,450,812,1200,1440,480,868,1290,1530,510,924,1350,1620,540,980,1440,1710,570,1036,1530,1800,570,1064,1590,1890,600,1120,1680,1980,630,1204,1770,2100,660,1260,1860,2220,720,1316,1950,2310,750,1372,2040,2430];e.getBlocksCount=function(u,c){switch(c){case t.L:return n[4*(u-1)+0];case t.M:return n[4*(u-1)+1];case t.Q:return n[4*(u-1)+2];case t.H:return n[4*(u-1)+3];default:return}},e.getTotalCodewordsCount=function(n,c){switch(c){case t.L:return u[4*(n-1)+0];case t.M:return u[4*(n-1)+1];case t.Q:return u[4*(n-1)+2];case t.H:return u[4*(n-1)+3];default:return}}},6031,[6025]);
__d(function(g,r,i,a,m,e,d){const t=r(d[0]);function n(t){this.genPoly=void 0,this.degree=t,this.degree&&this.initialize(this.degree)}n.prototype.initialize=function(n){this.degree=n,this.genPoly=t.generateECPolynomial(this.degree)},n.prototype.encode=function(n){if(!this.genPoly)throw new Error('Encoder not initialized');const o=new Uint8Array(n.length+this.degree);o.set(n);const s=t.mod(o,this.genPoly),h=this.degree-s.length;if(h>0){const t=new Uint8Array(this.degree);return t.set(s,h),t}return s},m.exports=n},6032,[6033]);
__d(function(g,r,_i,a,m,e,d){const n=r(d[0]);e.mul=function(t,l){const o=new Uint8Array(t.length+l.length-1);for(let u=0;u<t.length;u++)for(let f=0;f<l.length;f++)o[u+f]^=n.mul(t[u],l[f]);return o},e.mod=function(t,l){let o=new Uint8Array(t);for(;o.length-l.length>=0;){const t=o[0];for(let u=0;u<l.length;u++)o[u]^=n.mul(l[u],t);let u=0;for(;u<o.length&&0===o[u];)u++;o=o.slice(u)}return o},e.generateECPolynomial=function(t){let l=new Uint8Array([1]);for(let o=0;o<t;o++)l=e.mul(l,new Uint8Array([1,n.exp(o)]));return l}},6033,[6034]);
__d(function(g,r,_i,a,m,e,d){const n=new Uint8Array(512),t=new Uint8Array(256);!(function(){let o=1;for(let u=0;u<255;u++)n[u]=o,t[o]=u,o<<=1,256&o&&(o^=285);for(let t=255;t<512;t++)n[t]=n[t-255]})(),e.log=function(n){if(n<1)throw new Error('log('+n+')');return t[n]},e.exp=function(t){return n[t]},e.mul=function(o,u){return 0===o||0===u?0:n[t[o]+t[u]]}},6034,[]);
__d(function(g,r,i,a,m,e,_d){const t=r(_d[0]),n=r(_d[1]),o=r(_d[2]),f=r(_d[3]),u=r(_d[4]),c=t.getBCHDigit(7973);function s(t,n,o){for(let f=1;f<=40;f++)if(n<=e.getCapacity(f,o,t))return f}function l(t,n){return f.getCharCountIndicator(t,n)+4}function d(t,n){let o=0;return t.forEach(function(t){const f=l(t.mode,n);o+=f+t.getBitsLength()}),o}function C(t,n){for(let o=1;o<=40;o++){if(d(t,o)<=e.getCapacity(o,n,f.MIXED))return o}}e.from=function(t,n){return u.isValid(t)?parseInt(t,10):n},e.getCapacity=function(o,c,s){if(!u.isValid(o))throw new Error('Invalid QR Code version');void 0===s&&(s=f.BYTE);const d=8*(t.getSymbolTotalCodewords(o)-n.getTotalCodewordsCount(o,c));if(s===f.MIXED)return d;const C=d-l(s,o);switch(s){case f.NUMERIC:return Math.floor(C/10*3);case f.ALPHANUMERIC:return Math.floor(C/11*2);case f.KANJI:return Math.floor(C/13);case f.BYTE:default:return Math.floor(C/8)}},e.getBestVersionForData=function(t,n){let f;const u=o.from(n,o.M);if(Array.isArray(t)){if(t.length>1)return C(t,u);if(0===t.length)return 1;f=t[0]}else f=t;return s(f.mode,f.getLength(),u)},e.getEncodedBits=function(n){if(!u.isValid(n)||n<7)throw new Error('Invalid QR Code version');let o=n<<12;for(;t.getBCHDigit(o)-c>=0;)o^=7973<<t.getBCHDigit(o)-c;return n<<12|o}},6035,[6024,6031,6025,6036,6037]);
__d(function(g,r,i,a,m,_e,d){const t=r(d[0]),n=r(d[1]);function e(t){if('string'!=typeof t)throw new Error('Param is not a string');switch(t.toLowerCase()){case'numeric':return _e.NUMERIC;case'alphanumeric':return _e.ALPHANUMERIC;case'kanji':return _e.KANJI;case'byte':return _e.BYTE;default:throw new Error('Unknown mode: '+t)}}_e.NUMERIC={id:'Numeric',bit:1,ccBits:[10,12,14]},_e.ALPHANUMERIC={id:'Alphanumeric',bit:2,ccBits:[9,11,13]},_e.BYTE={id:'Byte',bit:4,ccBits:[8,16,16]},_e.KANJI={id:'Kanji',bit:8,ccBits:[8,10,12]},_e.MIXED={bit:-1},_e.getCharCountIndicator=function(n,e){if(!n.ccBits)throw new Error('Invalid mode: '+n);if(!t.isValid(e))throw new Error('Invalid version: '+e);return e>=1&&e<10?n.ccBits[0]:e<27?n.ccBits[1]:n.ccBits[2]},_e.getBestModeForData=function(t){return n.testNumeric(t)?_e.NUMERIC:n.testAlphanumeric(t)?_e.ALPHANUMERIC:n.testKanji(t)?_e.KANJI:_e.BYTE},_e.toString=function(t){if(t&&t.id)return t.id;throw new Error('Invalid mode')},_e.isValid=function(t){return t&&t.bit&&t.ccBits},_e.from=function(t,n){if(_e.isValid(t))return t;try{return e(t)}catch(t){return n}}},6036,[6037,6038]);
__d(function(g,r,i,a,m,e,d){e.isValid=function(n){return!isNaN(n)&&n>=1&&n<=40}},6037,[]);
__d(function(g,r,i,a,m,e,d){let u="(?:[u3000-u303F]|[u3040-u309F]|[u30A0-u30FF]|[uFF00-uFFEF]|[u4E00-u9FAF]|[u2605-u2606]|[u2190-u2195]|u203B|[u2010u2015u2018u2019u2025u2026u201Cu201Du2225u2260]|[u0391-u0451]|[u00A7u00A8u00B1u00B4u00D7u00F7])+";u=u.replace(/u/g,'\\u');const n='(?:(?![A-Z0-9 $%*+\\-./:]|'+u+')(?:.|[\r\n]))+';e.KANJI=new RegExp(u,'g'),e.BYTE_KANJI=new RegExp('[^A-Z0-9 $%*+\\-./:]+','g'),e.BYTE=new RegExp(n,'g'),e.NUMERIC=new RegExp('[0-9]+','g'),e.ALPHANUMERIC=new RegExp('[A-Z $%*+\\-./:]+','g');const t=new RegExp('^'+u+'$'),E=new RegExp("^[0-9]+$"),A=new RegExp('^[A-Z0-9 $%*+\\-./:]+$');e.testKanji=function(u){return t.test(u)},e.testNumeric=function(u){return E.test(u)},e.testAlphanumeric=function(u){return A.test(u)}},6038,[]);
__d(function(g,r,i,a,m,e,_d){const t=r(_d[0]),n=t.getBCHDigit(1335);e.getEncodedBits=function(o,c){const B=o.bit<<3|c;let d=B<<10;for(;t.getBCHDigit(d)-n>=0;)d^=1335<<t.getBCHDigit(d)-n;return 21522^(B<<10|d)}},6039,[6024]);
__d(function(g,r,_i,a,m,e,d){const t=r(d[0]),n=r(d[1]),o=r(d[2]),u=r(d[3]),s=r(d[4]),l=r(d[5]),c=r(d[6]),h=r(d[7]);function i(t){return unescape(encodeURIComponent(t)).length}function f(t,n,o){const u=[];let s;for(;null!==(s=t.exec(o));)u.push({data:s[0],index:s.index,mode:n,length:s[0].length});return u}function E(n){const o=f(l.NUMERIC,t.NUMERIC,n),u=f(l.ALPHANUMERIC,t.ALPHANUMERIC,n);let s,h;c.isKanjiModeEnabled()?(s=f(l.BYTE,t.BYTE,n),h=f(l.KANJI,t.KANJI,n)):(s=f(l.BYTE_KANJI,t.BYTE,n),h=[]);return o.concat(u,s,h).sort(function(t,n){return t.index-n.index}).map(function(t){return{data:t.data,mode:t.mode,length:t.length}})}function A(l,c){switch(c){case t.NUMERIC:return n.getBitsLength(l);case t.ALPHANUMERIC:return o.getBitsLength(l);case t.KANJI:return s.getBitsLength(l);case t.BYTE:return u.getBitsLength(l)}}function I(t){return t.reduce(function(t,n){const o=t.length-1>=0?t[t.length-1]:null;return o&&o.mode===n.mode?(t[t.length-1].data+=n.data,t):(t.push(n),t)},[])}function C(n){const o=[];for(let u=0;u<n.length;u++){const s=n[u];switch(s.mode){case t.NUMERIC:o.push([s,{data:s.data,mode:t.ALPHANUMERIC,length:s.length},{data:s.data,mode:t.BYTE,length:s.length}]);break;case t.ALPHANUMERIC:o.push([s,{data:s.data,mode:t.BYTE,length:s.length}]);break;case t.KANJI:o.push([s,{data:s.data,mode:t.BYTE,length:i(s.data)}]);break;case t.BYTE:o.push([{data:s.data,mode:t.BYTE,length:i(s.data)}])}}return o}function p(n,o){const u={},s={start:{}};let l=['start'];for(let c=0;c<n.length;c++){const h=n[c],i=[];for(let n=0;n<h.length;n++){const f=h[n],E=''+c+n;i.push(E),u[E]={node:f,lastCount:0},s[E]={};for(let n=0;n<l.length;n++){const c=l[n];u[c]&&u[c].node.mode===f.mode?(s[c][E]=A(u[c].lastCount+f.length,f.mode)-A(u[c].lastCount,f.mode),u[c].lastCount+=f.length):(u[c]&&(u[c].lastCount=f.length),s[c][E]=A(f.length,f.mode)+4+t.getCharCountIndicator(f.mode,o))}}l=i}for(let t=0;t<l.length;t++)s[l[t]].end=0;return{map:s,table:u}}function B(l,h){let i;const f=t.getBestModeForData(l);if(i=t.from(h,f),i!==t.BYTE&&i.bit<f.bit)throw new Error('"'+l+"\" cannot be encoded with mode "+t.toString(i)+'.\n Suggested mode is: '+t.toString(f));switch(i!==t.KANJI||c.isKanjiModeEnabled()||(i=t.BYTE),i){case t.NUMERIC:return new n(l);case t.ALPHANUMERIC:return new o(l);case t.KANJI:return new s(l);case t.BYTE:return new u(l)}}e.fromArray=function(t){return t.reduce(function(t,n){return'string'==typeof n?t.push(B(n,null)):n.data&&t.push(B(n.data,n.mode)),t},[])},e.fromString=function(t,n){const o=p(C(E(t,c.isKanjiModeEnabled())),n),u=h.find_path(o.map,'start','end'),s=[];for(let t=1;t<u.length-1;t++)s.push(o.table[u[t]].node);return e.fromArray(I(s))},e.rawSplit=function(t){return e.fromArray(E(t,c.isKanjiModeEnabled()))}},6040,[6036,6041,6042,6043,6045,6038,6024,1225]);
__d(function(g,r,_i,a,m,e,d){const t=r(d[0]);function n(n){this.mode=t.NUMERIC,this.data=n.toString()}n.getBitsLength=function(t){return 10*Math.floor(t/3)+(t%3?t%3*3+1:0)},n.prototype.getLength=function(){return this.data.length},n.prototype.getBitsLength=function(){return n.getBitsLength(this.data.length)},n.prototype.write=function(t){let n,o,s;for(n=0;n+3<=this.data.length;n+=3)o=this.data.substr(n,3),s=parseInt(o,10),t.put(s,10);const i=this.data.length-n;i>0&&(o=this.data.substr(n),s=parseInt(o,10),t.put(s,3*i+1))},m.exports=n},6041,[6036]);
__d(function(g,r,_i,a,m,e,d){const t=r(d[0]),n=['0','1','2','3','4','5','6','7','8','9','A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U','V','W','X','Y','Z',' ','$','%','*','+','-','.','/',':'];function i(n){this.mode=t.ALPHANUMERIC,this.data=n}i.getBitsLength=function(t){return 11*Math.floor(t/2)+t%2*6},i.prototype.getLength=function(){return this.data.length},i.prototype.getBitsLength=function(){return i.getBitsLength(this.data.length)},i.prototype.write=function(t){let i;for(i=0;i+2<=this.data.length;i+=2){let h=45*n.indexOf(this.data[i]);h+=n.indexOf(this.data[i+1]),t.put(h,11)}this.data.length%2&&t.put(n.indexOf(this.data[i]),6)},m.exports=i},6042,[6036]);
__d(function(g,r,_i,a,m,e,d){const t=r(d[0]),n=r(d[1]);function i(i){this.mode=n.BYTE,'string'==typeof i&&(i=t(i)),this.data=new Uint8Array(i)}i.getBitsLength=function(t){return 8*t},i.prototype.getLength=function(){return this.data.length},i.prototype.getBitsLength=function(){return i.getBitsLength(this.data.length)},i.prototype.write=function(t){for(let n=0,i=this.data.length;n<i;n++)t.put(this.data[n],8)},m.exports=i},6043,[6044,6036]);
__d(function(g,r,i,a,m,e,d){'use strict';m.exports=function(u){for(var h=[],s=u.length,p=0;p<s;p++){var t=u.charCodeAt(p);if(t>=55296&&t<=56319&&s>p+1){var n=u.charCodeAt(p+1);n>=56320&&n<=57343&&(t=1024*(t-55296)+n-56320+65536,p+=1)}t<128?h.push(t):t<2048?(h.push(t>>6|192),h.push(63&t|128)):t<55296||t>=57344&&t<65536?(h.push(t>>12|224),h.push(t>>6&63|128),h.push(63&t|128)):t>=65536&&t<=1114111?(h.push(t>>18|240),h.push(t>>12&63|128),h.push(t>>6&63|128),h.push(63&t|128)):h.push(239,191,189)}return new Uint8Array(h).buffer}},6044,[]);
__d(function(g,r,_i,a,m,e,d){const t=r(d[0]),n=r(d[1]);function i(n){this.mode=t.KANJI,this.data=n}i.getBitsLength=function(t){return 13*t},i.prototype.getLength=function(){return this.data.length},i.prototype.getBitsLength=function(){return i.getBitsLength(this.data.length)},i.prototype.write=function(t){let i;for(i=0;i<this.data.length;i++){let o=n.toSJIS(this.data[i]);if(o>=33088&&o<=40956)o-=33088;else{if(!(o>=57408&&o<=60351))throw new Error('Invalid SJIS character: '+this.data[i]+"\nMake sure your charset is UTF-8");o-=49472}o=192*(o>>>8&255)+(255&o),t.put(o,13)}},m.exports=i},6045,[6036,6024]);
__d(function(g,r,i,a,m,_e,d){const t=r(d[0]);function e(t,e,n){t.clearRect(0,0,e.width,e.height),e.style||(e.style={}),e.height=n,e.width=n,e.style.height=n+'px',e.style.width=n+'px'}function n(){try{return document.createElement('canvas')}catch(t){throw new Error('You need to specify a canvas element')}}_e.render=function(o,c,s){let u=s,h=c;void 0!==u||c&&c.getContext||(u=c,c=void 0),c||(h=n()),u=t.getOptions(u);const l=t.getImageWidth(o.modules.size,u),p=h.getContext('2d'),y=p.createImageData(l,l);return t.qrToImageData(y.data,o,u),e(p,h,l),p.putImageData(y,0,0),h},_e.renderToDataURL=function(t,e,n){let o=n;void 0!==o||e&&e.getContext||(o=e,e=void 0),o||(o={});const c=_e.render(t,e,o),s=o.type||'image/png',u=o.rendererOpts||{};return c.toDataURL(s,u.quality)}},6046,[6047]);
__d(function(g,r,_i,a,m,e,d){function t(t){if('number'==typeof t&&(t=t.toString()),'string'!=typeof t)throw new Error('Color should be defined as hex string');let o=t.slice().replace('#','').split('');if(o.length<3||5===o.length||o.length>8)throw new Error('Invalid hex color: '+t);3!==o.length&&4!==o.length||(o=Array.prototype.concat.apply([],o.map(function(t){return[t,t]}))),6===o.length&&o.push('F','F');const n=parseInt(o.join(''),16);return{r:n>>24&255,g:n>>16&255,b:n>>8&255,a:255&n,hex:'#'+o.slice(0,6).join('')}}e.getOptions=function(o){o||(o={}),o.color||(o.color={});const n=void 0===o.margin||null===o.margin||o.margin<0?4:o.margin,i=o.width&&o.width>=21?o.width:void 0,l=o.scale||4;return{width:i,scale:i?4:l,margin:n,color:{dark:t(o.color.dark||'#000000ff'),light:t(o.color.light||'#ffffffff')},type:o.type,rendererOpts:o.rendererOpts||{}}},e.getScale=function(t,o){return o.width&&o.width>=t+2*o.margin?o.width/(t+2*o.margin):o.scale},e.getImageWidth=function(t,o){const n=e.getScale(t,o);return Math.floor((t+2*o.margin)*n)},e.qrToImageData=function(t,o,n){const i=o.modules.size,l=o.modules.data,c=e.getScale(i,n),f=Math.floor((i+2*n.margin)*c),h=n.margin*c,s=[n.color.light,n.color.dark];for(let o=0;o<f;o++)for(let u=0;u<f;u++){let p=4*(o*f+u),w=n.color.light;if(o>=h&&u>=h&&o<f-h&&u<f-h){w=s[l[Math.floor((o-h)/c)*i+Math.floor((u-h)/c)]?1:0]}t[p++]=w.r,t[p++]=w.g,t[p++]=w.b,t[p]=w.a}}},6047,[]);
__d(function(g,r,_i,a,m,e,d){const t=r(d[0]);function o(t,o){const n=t.a/255,i=o+'="'+t.hex+'"';return n<1?i+' '+o+'-opacity="'+n.toFixed(2).slice(1)+'"':i}function n(t,o,n){let i=t+o;return void 0!==n&&(i+=' '+n),i}function i(t,o,i){let l='',h=0,s=!1,c=0;for(let u=0;u<t.length;u++){const f=Math.floor(u%o),w=Math.floor(u/o);f||s||(s=!0),t[u]?(c++,u>0&&f>0&&t[u-1]||(l+=s?n('M',f+i,.5+w+i):n('m',h,0),h=0,s=!1),f+1<o&&t[u+1]||(l+=n('h',c),c=0)):h++}return l}e.render=function(n,l,h){const s=t.getOptions(l),c=n.modules.size,u=n.modules.data,f=c+2*s.margin,w=s.color.light.a?'<path '+o(s.color.light,'fill')+' d="M0 0h'+f+'v'+f+'H0z"/>':'',p='<path '+o(s.color.dark,'stroke')+' d="'+i(u,c,s.margin)+'"/>',v="viewBox=\"0 0 "+f+' '+f+'"',x='<svg xmlns="http://www.w3.org/2000/svg" '+(s.width?'width="'+s.width+'" height="'+s.width+'" ':'')+v+' shape-rendering="crispEdges">'+w+p+'</svg>\n';return'function'==typeof h&&h(null,x),x}},6048,[6047]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var t=r(d[0]);e.default=t.css`
  :host {
    position: relative;
    user-select: none;
    display: block;
    overflow: hidden;
    aspect-ratio: 1 / 1;
    width: 100%;
    height: 100%;
    background-color: ${({colors:t})=>t.white};
    border: 1px solid ${({tokens:t})=>t.theme.borderPrimary};
  }

  :host {
    border-radius: ${({borderRadius:t})=>t[4]};
    display: flex;
    align-items: center;
    justify-content: center;
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
    background-color: ${({tokens:t})=>t.theme.backgroundPrimary};
    box-shadow: inset 0 0 0 4px ${({tokens:t})=>t.theme.backgroundPrimary};
    border-radius: ${({borderRadius:t})=>t[6]};
  }

  wui-image {
    width: 25%;
    height: 25%;
    border-radius: ${({borderRadius:t})=>t[2]};
  }

  wui-icon {
    width: 100%;
    height: 100%;
    color: #3396ff !important;
    transform: translateY(-50%) translateX(-50%) scale(0.25);
  }

  wui-icon > svg {
    width: inherit;
    height: inherit;
  }
`},6049,[4559]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var o=r(d[0]);e.default=o.css`
  wui-shimmer {
    width: 100%;
    aspect-ratio: 1 / 1;
    border-radius: ${({borderRadius:o})=>o[4]};
  }

  wui-qr-code {
    opacity: 0;
    animation-duration: ${({durations:o})=>o.xl};
    animation-timing-function: ${({easings:o})=>o['ease-out-power-2']};
    animation-name: fade-in;
    animation-fill-mode: forwards;
  }

  @keyframes fade-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
`},6050,[4550]);
__d(function(g,_r,_i,a,m,e,_d){Object.defineProperty(e,"__esModule",{value:!0}),e.W3mConnectingWcUnsupported=void 0;var t=_r(_d[0]),l=_r(_d[1]),n=_r(_d[2]),r=_r(_d[3]);_r(_d[4]),_r(_d[5]),_r(_d[6]),_r(_d[7]);var o=this&&this.__decorate||function(t,l,n,r){var o,i=arguments.length,c=i<3?l:null===r?r=Object.getOwnPropertyDescriptor(l,n):r;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)c=Reflect.decorate(t,l,n,r);else for(var s=t.length-1;s>=0;s--)(o=t[s])&&(c=(i<3?o(c):i>3?o(l,n,c):o(l,n))||c);return i>3&&c&&Object.defineProperty(l,n,c),c};let i=e.W3mConnectingWcUnsupported=class extends t.LitElement{constructor(){if(super(),this.wallet=n.RouterController.state.data?.wallet,!this.wallet)throw new Error('w3m-connecting-wc-unsupported: No wallet provided');n.EventsController.sendEvent({type:'track',event:'SELECT_WALLET',properties:{name:this.wallet.name,platform:'browser',displayIndex:this.wallet?.display_index,walletRank:this.wallet?.order,view:n.RouterController.state.view}})}render(){return t.html`
      <wui-flex
        flexDirection="column"
        alignItems="center"
        .padding=${['10','5','5','5']}
        gap="5"
      >
        <wui-wallet-image
          size="lg"
          imageSrc=${(0,l.ifDefined)(n.AssetUtil.getWalletImage(this.wallet))}
        ></wui-wallet-image>

        <wui-text variant="md-regular" color="primary">Not Detected</wui-text>
      </wui-flex>

      <w3m-mobile-download-links .wallet=${this.wallet}></w3m-mobile-download-links>
    `}};e.W3mConnectingWcUnsupported=i=o([(0,r.customElement)('w3m-connecting-wc-unsupported')],i)},6051,[4553,4588,4532,4550,4585,4647,4648,6009]);
__d(function(g,_r,_i,a,m,e,_d){Object.defineProperty(e,"__esModule",{value:!0}),e.W3mConnectingWcWeb=void 0;var t=_r(_d[0]),n=_r(_d[1]),i=_r(_d[2]),o=_r(_d[3]),r=this&&this.__decorate||function(t,n,i,o){var r,l=arguments.length,s=l<3?n:null===o?o=Object.getOwnPropertyDescriptor(n,i):o;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)s=Reflect.decorate(t,n,i,o);else for(var c=t.length-1;c>=0;c--)(r=t[c])&&(s=(l<3?r(s):l>3?r(n,i,s):r(n,i))||s);return l>3&&s&&Object.defineProperty(n,i,s),s};let l=e.W3mConnectingWcWeb=class extends o.W3mConnectingWidget{constructor(){if(super(),this.isLoading=!0,!this.wallet)throw new Error('w3m-connecting-wc-web: No wallet provided');this.onConnect=this.onConnectProxy.bind(this),this.secondaryBtnLabel='Open',this.secondaryLabel=n.ConstantsUtil.CONNECT_LABELS.MOBILE,this.secondaryBtnIcon='externalLink',this.updateLoadingState(),this.unsubscribe.push(n.ConnectionController.subscribeKey('wcUri',()=>{this.updateLoadingState()})),n.EventsController.sendEvent({type:'track',event:'SELECT_WALLET',properties:{name:this.wallet.name,platform:'web',displayIndex:this.wallet?.display_index,walletRank:this.wallet?.order,view:n.RouterController.state.view}})}updateLoadingState(){this.isLoading=!this.uri}onConnectProxy(){if(this.wallet?.webapp_link&&this.uri)try{this.error=!1;const{webapp_link:t,name:i}=this.wallet,{redirect:o,href:r}=n.CoreHelperUtil.formatUniversalUrl(t,this.uri);n.ConnectionController.setWcLinking({name:i,href:r}),n.ConnectionController.setRecentWallet(this.wallet),n.CoreHelperUtil.openHref(o,'_blank')}catch{this.error=!0}}};r([(0,t.state)()],l.prototype,"isLoading",void 0),e.W3mConnectingWcWeb=l=r([(0,i.customElement)('w3m-connecting-wc-web')],l)},6052,[4574,4532,4550,6004]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var t=r(d[0]);e.default=t.css`
  :host([data-mobile-fullscreen='true']) {
    height: 100%;
    display: flex;
    flex-direction: column;
  }

  :host([data-mobile-fullscreen='true']) wui-ux-by-reown {
    margin-top: auto;
  }
`},6053,[4550]);
__d(function(g,_r,_i,a,m,e,_d){Object.defineProperty(e,"__esModule",{value:!0}),e.W3mAllWalletsView=void 0;var t=_r(_d[0]),i=_r(_d[1]),l=_r(_d[2]),n=_r(_d[3]);_r(_d[4]),_r(_d[5]),_r(_d[6]),_r(_d[7]),_r(_d[8]),_r(_d[9]);var r=this&&this.__decorate||function(t,i,l,n){var r,o=arguments.length,c=o<3?i:null===n?n=Object.getOwnPropertyDescriptor(i,l):n;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)c=Reflect.decorate(t,i,l,n);else for(var s=t.length-1;s>=0;s--)(r=t[s])&&(c=(o<3?r(c):o>3?r(i,l,c):r(i,l))||c);return o>3&&c&&Object.defineProperty(i,l,c),c};let o=e.W3mAllWalletsView=class extends t.LitElement{constructor(){super(...arguments),this.search='',this.badge=void 0,this.onDebouncedSearch=l.CoreHelperUtil.debounce(t=>{this.search=t})}render(){const i=this.search.length>=2;return t.html`
      <wui-flex .padding=${['1','3','3','3']} gap="2" alignItems="center">
        <wui-search-bar @inputChange=${this.onInputChange.bind(this)}></wui-search-bar>
        <wui-certified-switch
          ?checked=${'certified'===this.badge}
          @certifiedSwitchChange=${this.onCertifiedSwitchChange.bind(this)}
          data-testid="wui-certified-switch"
        ></wui-certified-switch>
        ${this.qrButtonTemplate()}
      </wui-flex>
      ${i||this.badge?t.html`<w3m-all-wallets-search
            query=${this.search}
            .badge=${this.badge}
          ></w3m-all-wallets-search>`:t.html`<w3m-all-wallets-list .badge=${this.badge}></w3m-all-wallets-list>`}
    `}onInputChange(t){this.onDebouncedSearch(t.detail)}onCertifiedSwitchChange(t){t.detail?(this.badge='certified',l.SnackController.showSvg('Only WalletConnect certified',{icon:'walletConnectBrown',iconColor:'accent-100'})):this.badge=void 0}qrButtonTemplate(){return l.CoreHelperUtil.isMobile()?t.html`
        <wui-icon-box
          size="xl"
          iconSize="xl"
          color="accent-primary"
          icon="qrCode"
          border
          borderColor="wui-accent-glass-010"
          @click=${this.onWalletConnectQr.bind(this)}
        ></wui-icon-box>
      `:null}onWalletConnectQr(){l.RouterController.push('ConnectingWalletConnect')}};r([(0,i.state)()],o.prototype,"search",void 0),r([(0,i.state)()],o.prototype,"badge",void 0),e.W3mAllWalletsView=o=r([(0,n.customElement)('w3m-all-wallets-view')],o)},6054,[4553,4574,4532,4550,6055,4585,6005,6064,6069,6079]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0});var n=r(d[0]);Object.keys(n).forEach(function(t){"default"!==t&&"__esModule"!==t&&(t in e&&e[t]===n[t]||Object.defineProperty(e,t,{enumerable:!0,get:function(){return n[t]}}))})},6055,[6056]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.WuiCertifiedSwitch=void 0;var i=_r(_d[1]),c=_r(_d[2]),n=_r(_d[3]),o=_r(_d[4]);_r(_d[5]);var r=t(_r(_d[6])),h=this&&this.__decorate||function(t,i,c,n){var o,r=arguments.length,h=r<3?i:null===n?n=Object.getOwnPropertyDescriptor(i,c):n;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)h=Reflect.decorate(t,i,c,n);else for(var s=t.length-1;s>=0;s--)(o=t[s])&&(h=(r<3?o(h):r>3?o(i,c,h):o(i,c))||h);return r>3&&h&&Object.defineProperty(i,c,h),h};let s=e.WuiCertifiedSwitch=class extends i.LitElement{constructor(){super(...arguments),this.checked=!1}render(){return i.html`
      <wui-flex>
        <wui-icon size="xl" name="walletConnectBrown"></wui-icon>
        <wui-toggle
          ?checked=${this.checked}
          size="sm"
          @switchChange=${this.handleToggleChange.bind(this)}
        ></wui-toggle>
      </wui-flex>
    `}handleToggleChange(t){t.stopPropagation(),this.checked=t.detail,this.dispatchSwitchEvent()}dispatchSwitchEvent(){this.dispatchEvent(new CustomEvent('certifiedSwitchChange',{detail:this.checked,bubbles:!0,composed:!0}))}};s.styles=[n.resetStyles,n.elementStyles,r.default],h([(0,c.property)({type:Boolean})],s.prototype,"checked",void 0),e.WuiCertifiedSwitch=s=h([(0,o.customElement)('wui-certified-switch')],s)},6056,[2,4553,4574,4552,4563,6057,6063]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.WuiToggle=void 0;var i=_r(_d[1]),s=_r(_d[2]),o=_r(_d[3]),n=_r(_d[4]),l=_r(_d[5]),c=t(_r(_d[6])),r=this&&this.__decorate||function(t,i,s,o){var n,l=arguments.length,c=l<3?i:null===o?o=Object.getOwnPropertyDescriptor(i,s):o;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)c=Reflect.decorate(t,i,s,o);else for(var r=t.length-1;r>=0;r--)(n=t[r])&&(c=(l<3?n(c):l>3?n(i,s,c):n(i,s))||c);return l>3&&c&&Object.defineProperty(i,s,c),c};let d=e.WuiToggle=class extends i.LitElement{constructor(){super(...arguments),this.inputElementRef=(0,o.createRef)(),this.checked=!1,this.disabled=!1,this.size='md'}render(){return i.html`
      <label data-size=${this.size}>
        <input
          ${(0,o.ref)(this.inputElementRef)}
          type="checkbox"
          ?checked=${this.checked}
          ?disabled=${this.disabled}
          @change=${this.dispatchChangeEvent.bind(this)}
        />
        <span></span>
      </label>
    `}dispatchChangeEvent(){this.dispatchEvent(new CustomEvent('switchChange',{detail:this.inputElementRef.value?.checked,bubbles:!0,composed:!0}))}};d.styles=[n.resetStyles,n.elementStyles,c.default],r([(0,s.property)({type:Boolean})],d.prototype,"checked",void 0),r([(0,s.property)({type:Boolean})],d.prototype,"disabled",void 0),r([(0,s.property)()],d.prototype,"size",void 0),e.WuiToggle=d=r([(0,l.customElement)('wui-toggle')],d)},6057,[2,4553,4574,6058,4552,4563,6062]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0});var n=r(d[0]);Object.keys(n).forEach(function(t){"default"!==t&&"__esModule"!==t&&(t in e&&e[t]===n[t]||Object.defineProperty(e,t,{enumerable:!0,get:function(){return n[t]}}))})},6058,[6059]);
__d(function(g,r,_i,a,m,_e,d){Object.defineProperty(_e,"__esModule",{value:!0}),_e.ref=_e.createRef=void 0;var t=r(d[0]),e=r(d[1]),i=r(d[2]);_e.createRef=()=>new s;class s{}const h=new WeakMap;_e.ref=(0,i.directive)(class extends e.AsyncDirective{render(e){return t.nothing}update(e,[i]){const s=i!==this.G;return s&&this.rt(void 0),(s||this.lt!==this.ct)&&(this.G=i,this.ht=e.options?.host,this.rt(this.ct=e.element)),t.nothing}rt(t){if(void 0!==this.G)if(this.isConnected||(t=void 0),"function"==typeof this.G){const e=this.ht??globalThis;let i=h.get(e);void 0===i&&(i=new WeakMap,h.set(e,i)),void 0!==i.get(this.G)&&this.G.call(this.ht,void 0),i.set(this.G,t),void 0!==t&&this.G.call(this.ht,t)}else this.G.value=t}get lt(){return"function"==typeof this.G?h.get(this.ht??globalThis)?.get(this.G):this.G?.value}disconnected(){this.lt===this.ct&&this.rt(void 0)}reconnected(){this.rt(this.ct)}})},6059,[4556,6060,4625]);
__d(function(g,_r,_i,a,m,_e,d){Object.defineProperty(_e,"__esModule",{value:!0}),_e.AsyncDirective=void 0,Object.defineProperty(_e,"Directive",{enumerable:!0,get:function(){return t.Directive}}),Object.defineProperty(_e,"PartType",{enumerable:!0,get:function(){return t.PartType}}),Object.defineProperty(_e,"directive",{enumerable:!0,get:function(){return t.directive}});var e=_r(d[0]),t=_r(d[1]);
/**
   * @license
   * Copyright 2017 Google LLC
   * SPDX-License-Identifier: BSD-3-Clause
   */
const i=(e,t)=>{const s=e._$AN;if(void 0===s)return!1;for(const e of s)e._$AO?.(t,!1),i(e,t);return!0},s=e=>{let t,i;do{if(void 0===(t=e._$AM))break;i=t._$AN,i.delete(e),e=t}while(0===i?.size)},n=e=>{for(let t;t=e._$AM;e=t){let i=t._$AN;if(void 0===i)t._$AN=i=new Set;else if(i.has(e))break;i.add(e),o(t)}};function r(e){void 0!==this._$AN?(s(this),this._$AM=e,n(this)):this._$AM=e}function c(e,t=!1,n=0){const r=this._$AH,c=this._$AN;if(void 0!==c&&0!==c.size)if(t)if(Array.isArray(r))for(let e=n;e<r.length;e++)i(r[e],!1),s(r[e]);else null!=r&&(i(r,!1),s(r));else i(this,e)}const o=e=>{e.type==t.PartType.CHILD&&(e._$AP??=c,e._$AQ??=r)};class _ extends t.Directive{constructor(){super(...arguments),this._$AN=void 0}_$AT(e,t,i){super._$AT(e,t,i),n(this),this.isConnected=e._$AU}_$AO(e,t=!0){e!==this.isConnected&&(this.isConnected=e,e?this.reconnected?.():this.disconnected?.()),t&&(i(this,e),s(this))}setValue(t){if((0,e.isSingleExpression)(this._$Ct))this._$Ct._$AI(t,this);else{const e=[...this._$Ct._$AH];e[this._$Ci]=t,this._$Ct._$AI(e,this,0)}}disconnected(){}reconnected(){}}_e.AsyncDirective=_},6060,[6061,4625]);
__d(function(g,_r,_i,a,_m,_e,_d){Object.defineProperty(_e,"__esModule",{value:!0}),_e.setCommittedValue=_e.setChildPartValue=_e.removePart=_e.isTemplateResult=_e.isSingleExpression=_e.isPrimitive=_e.isDirectiveResult=_e.isCompiledTemplateResult=_e.insertPart=_e.getDirectiveClass=_e.getCommittedValue=_e.clearPart=_e.TemplateResultType=void 0;var e=_r(_d[0]);
/**
   * @license
   * Copyright 2020 Google LLC
   * SPDX-License-Identifier: BSD-3-Clause
   */const{I:t}=e._$LH,i=e=>e,l=(_e.TemplateResultType={HTML:1,SVG:2,MATHML:3},()=>document.createComment("")),s={};_e.clearPart=e=>{e._$AR()},_e.removePart=e=>{e._$AR(),e._$AA.remove()},_e.getCommittedValue=e=>e._$AH,_e.setCommittedValue=(e,t=s)=>e._$AH=t,_e.setChildPartValue=(e,t,i=e)=>(e._$AI(t,i),e),_e.insertPart=(e,s,o)=>{const r=e._$AA.parentNode,n=void 0===s?e._$AB:s._$AA;if(void 0===o){const i=r.insertBefore(l(),n),s=r.insertBefore(l(),n);o=new t(i,s,e,e.options)}else{const t=o._$AB.nextSibling,l=o._$AM,s=l!==e;if(s){let t;o._$AQ?.(e),o._$AM=e,void 0!==o._$AP&&(t=e._$AU)!==l._$AU&&o._$AP(t)}if(t!==n||s){let e=o._$AA;for(;e!==t;){const t=i(e).nextSibling;i(r).insertBefore(e,n),e=t}}}return o},_e.isSingleExpression=e=>void 0===e.strings,_e.getDirectiveClass=e=>e?._$litDirective$,_e.isDirectiveResult=e=>void 0!==e?._$litDirective$,_e.isCompiledTemplateResult=e=>null!=e?._$litType$?.h,_e.isTemplateResult=(e,t)=>void 0===t?void 0!==e?._$litType$:e?._$litType$===t,_e.isPrimitive=e=>null===e||"object"!=typeof e&&"function"!=typeof e},6061,[4556]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var o=r(d[0]);e.default=o.css`
  :host {
    display: flex;
    align-items: center;
    justify-content: center;
  }

  label {
    position: relative;
    display: inline-block;
    user-select: none;
    transition:
      background-color ${({durations:o})=>o.lg}
        ${({easings:o})=>o['ease-out-power-2']},
      color ${({durations:o})=>o.lg} ${({easings:o})=>o['ease-out-power-2']},
      border ${({durations:o})=>o.lg} ${({easings:o})=>o['ease-out-power-2']},
      box-shadow ${({durations:o})=>o.lg}
        ${({easings:o})=>o['ease-out-power-2']},
      width ${({durations:o})=>o.lg} ${({easings:o})=>o['ease-out-power-2']},
      height ${({durations:o})=>o.lg} ${({easings:o})=>o['ease-out-power-2']},
      transform ${({durations:o})=>o.lg}
        ${({easings:o})=>o['ease-out-power-2']},
      opacity ${({durations:o})=>o.lg} ${({easings:o})=>o['ease-out-power-2']};
    will-change: background-color, color, border, box-shadow, width, height, transform, opacity;
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
    background-color: ${({colors:o})=>o.neutrals300};
    border-radius: ${({borderRadius:o})=>o.round};
    border: 1px solid transparent;
    will-change: border;
    transition:
      background-color ${({durations:o})=>o.lg}
        ${({easings:o})=>o['ease-out-power-2']},
      color ${({durations:o})=>o.lg} ${({easings:o})=>o['ease-out-power-2']},
      border ${({durations:o})=>o.lg} ${({easings:o})=>o['ease-out-power-2']},
      box-shadow ${({durations:o})=>o.lg}
        ${({easings:o})=>o['ease-out-power-2']},
      width ${({durations:o})=>o.lg} ${({easings:o})=>o['ease-out-power-2']},
      height ${({durations:o})=>o.lg} ${({easings:o})=>o['ease-out-power-2']},
      transform ${({durations:o})=>o.lg}
        ${({easings:o})=>o['ease-out-power-2']},
      opacity ${({durations:o})=>o.lg} ${({easings:o})=>o['ease-out-power-2']};
    will-change: background-color, color, border, box-shadow, width, height, transform, opacity;
  }

  span:before {
    content: '';
    position: absolute;
    background-color: ${({colors:o})=>o.white};
    border-radius: 50%;
  }

  /* -- Sizes --------------------------------------------------------- */
  label[data-size='lg'] {
    width: 48px;
    height: 32px;
  }

  label[data-size='md'] {
    width: 40px;
    height: 28px;
  }

  label[data-size='sm'] {
    width: 32px;
    height: 22px;
  }

  label[data-size='lg'] > span:before {
    height: 24px;
    width: 24px;
    left: 4px;
    top: 3px;
  }

  label[data-size='md'] > span:before {
    height: 20px;
    width: 20px;
    left: 4px;
    top: 3px;
  }

  label[data-size='sm'] > span:before {
    height: 16px;
    width: 16px;
    left: 3px;
    top: 2px;
  }

  /* -- Focus states --------------------------------------------------- */
  input:focus-visible:not(:checked) + span,
  input:focus:not(:checked) + span {
    border: 1px solid ${({tokens:o})=>o.core.iconAccentPrimary};
    background-color: ${({tokens:o})=>o.theme.textTertiary};
    box-shadow: 0px 0px 0px 4px rgba(9, 136, 240, 0.2);
  }

  input:focus-visible:checked + span,
  input:focus:checked + span {
    border: 1px solid ${({tokens:o})=>o.core.iconAccentPrimary};
    box-shadow: 0px 0px 0px 4px rgba(9, 136, 240, 0.2);
  }

  /* -- Checked states --------------------------------------------------- */
  input:checked + span {
    background-color: ${({tokens:o})=>o.core.iconAccentPrimary};
  }

  label[data-size='lg'] > input:checked + span:before {
    transform: translateX(calc(100% - 9px));
  }

  label[data-size='md'] > input:checked + span:before {
    transform: translateX(calc(100% - 9px));
  }

  label[data-size='sm'] > input:checked + span:before {
    transform: translateX(calc(100% - 7px));
  }

  /* -- Hover states ------------------------------------------------------- */
  label:hover > input:not(:checked):not(:disabled) + span {
    background-color: ${({colors:o})=>o.neutrals400};
  }

  label:hover > input:checked:not(:disabled) + span {
    background-color: ${({colors:o})=>o.accent080};
  }

  /* -- Disabled state --------------------------------------------------- */
  label:has(input:disabled) {
    pointer-events: none;
    user-select: none;
  }

  input:not(:checked):disabled + span {
    background-color: ${({colors:o})=>o.neutrals700};
  }

  input:checked:disabled + span {
    background-color: ${({colors:o})=>o.neutrals700};
  }

  input:not(:checked):disabled + span::before {
    background-color: ${({colors:o})=>o.neutrals400};
  }

  input:checked:disabled + span::before {
    background-color: ${({tokens:o})=>o.theme.textTertiary};
  }
`},6062,[4559]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var o=r(d[0]);e.default=o.css`
  :host {
    height: auto;
  }

  :host > wui-flex {
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    column-gap: ${({spacing:o})=>o[2]};
    padding: ${({spacing:o})=>o[2]} ${({spacing:o})=>o[3]};
    background-color: ${({tokens:o})=>o.theme.foregroundPrimary};
    border-radius: ${({borderRadius:o})=>o[4]};
    box-shadow: inset 0 0 0 1px ${({tokens:o})=>o.theme.foregroundPrimary};
    transition: background-color ${({durations:o})=>o.lg}
      ${({easings:o})=>o['ease-out-power-2']};
    will-change: background-color;
    cursor: pointer;
  }

  wui-switch {
    pointer-events: none;
  }
`},6063,[4559]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0});var n=r(d[0]);Object.keys(n).forEach(function(t){"default"!==t&&"__esModule"!==t&&(t in e&&e[t]===n[t]||Object.defineProperty(e,t,{enumerable:!0,get:function(){return n[t]}}))})},6064,[6065]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.WuiSearchBar=void 0;var n=_r(_d[1]),i=_r(_d[2]),r=_r(_d[3]),u=_r(_d[4]),l=_r(_d[5]);_r(_d[6]);var c=t(_r(_d[7])),o=this&&this.__decorate||function(t,n,i,r){var u,l=arguments.length,c=l<3?n:null===r?r=Object.getOwnPropertyDescriptor(n,i):r;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)c=Reflect.decorate(t,n,i,r);else for(var o=t.length-1;o>=0;o--)(u=t[o])&&(c=(l<3?u(c):l>3?u(n,i,c):u(n,i))||c);return l>3&&c&&Object.defineProperty(n,i,c),c};let s=e.WuiSearchBar=class extends n.LitElement{constructor(){super(...arguments),this.inputComponentRef=(0,r.createRef)(),this.inputValue=''}render(){return n.html`
      <wui-input-text
        ${(0,r.ref)(this.inputComponentRef)}
        placeholder="Search wallet"
        icon="search"
        type="search"
        enterKeyHint="search"
        size="sm"
        @inputChange=${this.onInputChange}
      >
        ${this.inputValue?n.html`<wui-icon
              @click=${this.clearValue}
              color="inherit"
              size="sm"
              name="close"
            ></wui-icon>`:null}
      </wui-input-text>
    `}onInputChange(t){this.inputValue=t.detail||''}clearValue(){const t=this.inputComponentRef.value,n=t?.inputElementRef.value;n&&(n.value='',this.inputValue='',n.focus(),n.dispatchEvent(new Event('input')))}};s.styles=[u.resetStyles,c.default],o([(0,i.property)()],s.prototype,"inputValue",void 0),e.WuiSearchBar=s=o([(0,l.customElement)('wui-search-bar')],s)},6065,[2,4553,4574,6058,4552,4563,6066,6068]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.WuiInputText=void 0;var i=_r(_d[1]),o=_r(_d[2]),n=_r(_d[3]),r=_r(_d[4]);_r(_d[5]),_r(_d[6]);var p=_r(_d[7]),s=_r(_d[8]),l=t(_r(_d[9])),u=this&&this.__decorate||function(t,i,o,n){var r,p=arguments.length,s=p<3?i:null===n?n=Object.getOwnPropertyDescriptor(i,o):n;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)s=Reflect.decorate(t,i,o,n);else for(var l=t.length-1;l>=0;l--)(r=t[l])&&(s=(p<3?r(s):p>3?r(i,o,s):r(i,o))||s);return p>3&&s&&Object.defineProperty(i,o,s),s};let d=e.WuiInputText=class extends i.LitElement{constructor(){super(...arguments),this.inputElementRef=(0,r.createRef)(),this.disabled=!1,this.loading=!1,this.placeholder='',this.type='text',this.value='',this.size='md'}render(){return i.html` <div class="wui-input-text-container">
        ${this.templateLeftIcon()}
        <input
          data-size=${this.size}
          ${(0,r.ref)(this.inputElementRef)}
          data-testid="wui-input-text"
          type=${this.type}
          enterkeyhint=${(0,n.ifDefined)(this.enterKeyHint)}
          ?disabled=${this.disabled}
          placeholder=${this.placeholder}
          @input=${this.dispatchInputChangeEvent.bind(this)}
          @keydown=${this.onKeyDown}
          .value=${this.value||''}
        />
        ${this.templateSubmitButton()}
        <slot class="wui-input-text-slot"></slot>
      </div>
      ${this.templateError()} ${this.templateWarning()}`}templateLeftIcon(){return this.icon?i.html`<wui-icon
        class="wui-input-text-left-icon"
        size="md"
        data-size=${this.size}
        color="inherit"
        name=${this.icon}
      ></wui-icon>`:null}templateSubmitButton(){return this.onSubmit?i.html`<button
        class="wui-input-text-submit-button ${this.loading?'loading':''}"
        @click=${this.onSubmit?.bind(this)}
        ?disabled=${this.disabled||this.loading}
      >
        ${this.loading?i.html`<wui-icon name="spinner" size="md"></wui-icon>`:i.html`<wui-icon name="chevronRight" size="md"></wui-icon>`}
      </button>`:null}templateError(){return this.errorText?i.html`<wui-text variant="sm-regular" color="error">${this.errorText}</wui-text>`:null}templateWarning(){return this.warningText?i.html`<wui-text variant="sm-regular" color="warning">${this.warningText}</wui-text>`:null}dispatchInputChangeEvent(){this.dispatchEvent(new CustomEvent('inputChange',{detail:this.inputElementRef.value?.value,bubbles:!0,composed:!0}))}};d.styles=[p.resetStyles,p.elementStyles,l.default],u([(0,o.property)()],d.prototype,"icon",void 0),u([(0,o.property)({type:Boolean})],d.prototype,"disabled",void 0),u([(0,o.property)({type:Boolean})],d.prototype,"loading",void 0),u([(0,o.property)()],d.prototype,"placeholder",void 0),u([(0,o.property)()],d.prototype,"type",void 0),u([(0,o.property)()],d.prototype,"value",void 0),u([(0,o.property)()],d.prototype,"errorText",void 0),u([(0,o.property)()],d.prototype,"warningText",void 0),u([(0,o.property)()],d.prototype,"onSubmit",void 0),u([(0,o.property)()],d.prototype,"size",void 0),u([(0,o.property)({attribute:!1})],d.prototype,"onKeyDown",void 0),e.WuiInputText=d=u([(0,s.customElement)('wui-input-text')],d)},6066,[2,4553,4574,4588,6058,4592,4622,4552,4563,6067]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var t=r(d[0]);e.default=t.css`
  :host {
    position: relative;
    width: 100%;
    display: inline-flex;
    flex-direction: column;
    gap: ${({spacing:t})=>t[3]};
    color: ${({tokens:t})=>t.theme.textPrimary};
    caret-color: ${({tokens:t})=>t.core.textAccentPrimary};
  }

  .wui-input-text-container {
    position: relative;
    display: flex;
  }

  input {
    width: 100%;
    border-radius: ${({borderRadius:t})=>t[4]};
    color: inherit;
    background: transparent;
    border: 1px solid ${({tokens:t})=>t.theme.borderPrimary};
    caret-color: ${({tokens:t})=>t.core.textAccentPrimary};
    padding: ${({spacing:t})=>t[3]} ${({spacing:t})=>t[3]}
      ${({spacing:t})=>t[3]} ${({spacing:t})=>t[10]};
    font-size: ${({textSize:t})=>t.large};
    line-height: ${({typography:t})=>t['lg-regular'].lineHeight};
    letter-spacing: ${({typography:t})=>t['lg-regular'].letterSpacing};
    font-weight: ${({fontWeight:t})=>t.regular};
    font-family: ${({fontFamily:t})=>t.regular};
  }

  input[data-size='lg'] {
    padding: ${({spacing:t})=>t[4]} ${({spacing:t})=>t[3]}
      ${({spacing:t})=>t[4]} ${({spacing:t})=>t[10]};
  }

  @media (hover: hover) and (pointer: fine) {
    input:hover:enabled {
      border: 1px solid ${({tokens:t})=>t.theme.borderSecondary};
    }
  }

  input:disabled {
    cursor: unset;
    border: 1px solid ${({tokens:t})=>t.theme.borderPrimary};
  }

  input::placeholder {
    color: ${({tokens:t})=>t.theme.textSecondary};
  }

  input:focus:enabled {
    border: 1px solid ${({tokens:t})=>t.theme.borderSecondary};
    background-color: ${({tokens:t})=>t.theme.foregroundPrimary};
    -webkit-box-shadow: 0px 0px 0px 4px ${({tokens:t})=>t.core.foregroundAccent040};
    -moz-box-shadow: 0px 0px 0px 4px ${({tokens:t})=>t.core.foregroundAccent040};
    box-shadow: 0px 0px 0px 4px ${({tokens:t})=>t.core.foregroundAccent040};
  }

  div.wui-input-text-container:has(input:disabled) {
    opacity: 0.5;
  }

  wui-icon.wui-input-text-left-icon {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    pointer-events: none;
    left: ${({spacing:t})=>t[4]};
    color: ${({tokens:t})=>t.theme.iconDefault};
  }

  button.wui-input-text-submit-button {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    right: ${({spacing:t})=>t[3]};
    width: 24px;
    height: 24px;
    border: none;
    background: transparent;
    border-radius: ${({borderRadius:t})=>t[2]};
    color: ${({tokens:t})=>t.core.textAccentPrimary};
  }

  button.wui-input-text-submit-button:disabled {
    opacity: 1;
  }

  button.wui-input-text-submit-button.loading wui-icon {
    animation: spin 1s linear infinite;
  }

  button.wui-input-text-submit-button:hover {
    background: ${({tokens:t})=>t.core.foregroundAccent010};
  }

  input:has(+ .wui-input-text-submit-button) {
    padding-right: ${({spacing:t})=>t[12]};
  }

  input[type='number'] {
    -moz-appearance: textfield;
  }

  input[type='search']::-webkit-search-decoration,
  input[type='search']::-webkit-search-cancel-button,
  input[type='search']::-webkit-search-results-button,
  input[type='search']::-webkit-search-results-decoration {
    -webkit-appearance: none;
  }

  /* -- Keyframes --------------------------------------------------- */
  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }
`},6067,[4559]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var o=r(d[0]);e.default=o.css`
  :host {
    position: relative;
    display: inline-block;
    width: 100%;
  }

  wui-icon {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    right: ${({spacing:o})=>o[3]};
    color: ${({tokens:o})=>o.theme.iconDefault};
    cursor: pointer;
    padding: ${({spacing:o})=>o[2]};
    background-color: transparent;
    border-radius: ${({borderRadius:o})=>o[4]};
    transition: background-color ${({durations:o})=>o.lg}
      ${({easings:o})=>o['ease-out-power-2']};
  }

  @media (hover: hover) {
    wui-icon:hover {
      background-color: ${({tokens:o})=>o.theme.foregroundSecondary};
    }
  }
`},6068,[4559]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.W3mAllWalletsList=void 0;var l=_r(_d[1]),i=_r(_d[2]),s=_r(_d[3]),n=_r(_d[4]),r=_r(_d[5]);_r(_d[6]),_r(_d[7]),_r(_d[8]);var o=t(_r(_d[9])),c=this&&this.__decorate||function(t,l,i,s){var n,r=arguments.length,o=r<3?l:null===s?s=Object.getOwnPropertyDescriptor(l,i):s;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)o=Reflect.decorate(t,l,i,s);else for(var c=t.length-1;c>=0;c--)(n=t[c])&&(o=(r<3?n(o):r>3?n(l,i,o):n(l,i))||o);return r>3&&o&&Object.defineProperty(l,i,o),o};const d='local-paginator';let h=e.W3mAllWalletsList=class extends l.LitElement{constructor(){super(),this.unsubscribe=[],this.paginationObserver=void 0,this.loading=!n.ApiController.state.wallets.length,this.wallets=n.ApiController.state.wallets,this.mobileFullScreen=n.OptionsController.state.enableMobileFullScreen,this.unsubscribe.push(n.ApiController.subscribeKey('wallets',t=>this.wallets=t))}firstUpdated(){this.initialFetch(),this.createPaginationObserver()}disconnectedCallback(){this.unsubscribe.forEach(t=>t()),this.paginationObserver?.disconnect()}render(){return this.mobileFullScreen&&this.setAttribute('data-mobile-fullscreen','true'),l.html`
      <wui-grid
        data-scroll=${!this.loading}
        .padding=${['0','3','3','3']}
        gap="2"
        justifyContent="space-between"
      >
        ${this.loading?this.shimmerTemplate(16):this.walletsTemplate()}
        ${this.paginationLoaderTemplate()}
      </wui-grid>
    `}async initialFetch(){this.loading=!0;const t=this.shadowRoot?.querySelector('wui-grid');t&&(await n.ApiController.fetchWalletsByPage({page:1}),await t.animate([{opacity:1},{opacity:0}],{duration:200,fill:'forwards',easing:'ease'}).finished,this.loading=!1,t.animate([{opacity:0},{opacity:1}],{duration:200,fill:'forwards',easing:'ease'}))}shimmerTemplate(t,i){return[...Array(t)].map(()=>l.html`
        <wui-card-select-loader type="wallet" id=${(0,s.ifDefined)(i)}></wui-card-select-loader>
      `)}walletsTemplate(){return n.WalletUtil.getWalletConnectWallets(this.wallets).map((t,i)=>l.html`
        <w3m-all-wallets-list-item
          data-testid="wallet-search-item-${t.id}"
          @click=${()=>this.onConnectWallet(t)}
          .wallet=${t}
          explorerId=${t.id}
          certified=${'certified'===this.badge}
          displayIndex=${i}
        ></w3m-all-wallets-list-item>
      `)}paginationLoaderTemplate(){const{wallets:t,recommended:l,featured:i,count:s,mobileFilteredOutWalletsLength:r}=n.ApiController.state,o=window.innerWidth<352?3:4,c=t.length+l.length;let h=Math.ceil(c/o)*o-c+o;return h-=t.length?i.length%o:0,0===s&&i.length>0?null:0===s||[...i,...t,...l].length<s-(r??0)?this.shimmerTemplate(h,d):null}createPaginationObserver(){const t=this.shadowRoot?.querySelector(`#${d}`);t&&(this.paginationObserver=new IntersectionObserver(([t])=>{if(t?.isIntersecting&&!this.loading){const{page:t,count:l,wallets:i}=n.ApiController.state;i.length<l&&n.ApiController.fetchWalletsByPage({page:t+1})}}),this.paginationObserver.observe(t))}onConnectWallet(t){n.ConnectorController.selectWalletConnector(t)}};h.styles=o.default,c([(0,i.state)()],h.prototype,"loading",void 0),c([(0,i.state)()],h.prototype,"wallets",void 0),c([(0,i.state)()],h.prototype,"badge",void 0),c([(0,i.state)()],h.prototype,"mobileFullScreen",void 0),e.W3mAllWalletsList=h=c([(0,r.customElement)('w3m-all-wallets-list')],h)},6069,[2,4553,4574,4588,4532,4550,6070,6073,6076,6078]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0});var n=r(d[0]);Object.keys(n).forEach(function(t){"default"!==t&&"__esModule"!==t&&(t in e&&e[t]===n[t]||Object.defineProperty(e,t,{enumerable:!0,get:function(){return n[t]}}))})},6070,[6071]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.WuiCardSelectLoader=void 0;var r=_r(_d[1]),i=_r(_d[2]),l=_r(_d[3]);_r(_d[4]);var o=_r(_d[5]),s=_r(_d[6]),h=t(_r(_d[7])),d=this&&this.__decorate||function(t,r,i,l){var o,s=arguments.length,h=s<3?r:null===l?l=Object.getOwnPropertyDescriptor(r,i):l;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)h=Reflect.decorate(t,r,i,l);else for(var d=t.length-1;d>=0;d--)(o=t[d])&&(h=(s<3?o(h):s>3?o(r,i,h):o(r,i))||h);return s>3&&h&&Object.defineProperty(r,i,h),h};let p=e.WuiCardSelectLoader=class extends r.LitElement{constructor(){super(...arguments),this.type='wallet'}render(){return r.html`
      ${this.shimmerTemplate()}
      <wui-shimmer width="80px" height="20px"></wui-shimmer>
    `}shimmerTemplate(){return'network'===this.type?r.html` <wui-shimmer data-type=${this.type} width="48px" height="54px"></wui-shimmer>
        ${l.networkSvgMd}`:r.html`<wui-shimmer width="56px" height="56px"></wui-shimmer>`}};p.styles=[o.resetStyles,o.elementStyles,h.default],d([(0,i.property)()],p.prototype,"type",void 0),e.WuiCardSelectLoader=p=d([(0,s.customElement)('wui-card-select-loader')],p)},6071,[2,4553,4574,4656,4650,4552,4563,6072]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var t=r(d[0]);e.default=t.css`
  :host {
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    height: 104px;
    width: 104px;
    row-gap: ${({spacing:t})=>t[2]};
    background-color: ${({tokens:t})=>t.theme.foregroundPrimary};
    border-radius: ${({borderRadius:t})=>t[5]};
    position: relative;
  }

  wui-shimmer[data-type='network'] {
    border: none;
    -webkit-clip-path: var(--apkt-path-network);
    clip-path: var(--apkt-path-network);
  }

  svg {
    position: absolute;
    width: 48px;
    height: 54px;
    z-index: 1;
  }

  svg > path {
    stroke: ${({tokens:t})=>t.theme.foregroundSecondary};
    stroke-width: 1px;
  }

  @media (max-width: 350px) {
    :host {
      width: 100%;
    }
  }
`},6072,[4559]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0});var n=r(d[0]);Object.keys(n).forEach(function(t){"default"!==t&&"__esModule"!==t&&(t in e&&e[t]===n[t]||Object.defineProperty(e,t,{enumerable:!0,get:function(){return n[t]}}))})},6073,[6074]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.WuiGrid=void 0;var i=_r(_d[1]),p=_r(_d[2]),n=_r(_d[3]),r=_r(_d[4]),o=_r(_d[5]),s=t(_r(_d[6])),l=this&&this.__decorate||function(t,i,p,n){var r,o=arguments.length,s=o<3?i:null===n?n=Object.getOwnPropertyDescriptor(i,p):n;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)s=Reflect.decorate(t,i,p,n);else for(var l=t.length-1;l>=0;l--)(r=t[l])&&(s=(o<3?r(s):o>3?r(i,p,s):r(i,p))||s);return o>3&&s&&Object.defineProperty(i,p,s),s};let d=e.WuiGrid=class extends i.LitElement{render(){return this.style.cssText=`\n      grid-template-rows: ${this.gridTemplateRows};\n      grid-template-columns: ${this.gridTemplateColumns};\n      justify-items: ${this.justifyItems};\n      align-items: ${this.alignItems};\n      justify-content: ${this.justifyContent};\n      align-content: ${this.alignContent};\n      column-gap: ${this.columnGap&&`var(--apkt-spacing-${this.columnGap})`};\n      row-gap: ${this.rowGap&&`var(--apkt-spacing-${this.rowGap})`};\n      gap: ${this.gap&&`var(--apkt-spacing-${this.gap})`};\n      padding-top: ${this.padding&&r.UiHelperUtil.getSpacingStyles(this.padding,0)};\n      padding-right: ${this.padding&&r.UiHelperUtil.getSpacingStyles(this.padding,1)};\n      padding-bottom: ${this.padding&&r.UiHelperUtil.getSpacingStyles(this.padding,2)};\n      padding-left: ${this.padding&&r.UiHelperUtil.getSpacingStyles(this.padding,3)};\n      margin-top: ${this.margin&&r.UiHelperUtil.getSpacingStyles(this.margin,0)};\n      margin-right: ${this.margin&&r.UiHelperUtil.getSpacingStyles(this.margin,1)};\n      margin-bottom: ${this.margin&&r.UiHelperUtil.getSpacingStyles(this.margin,2)};\n      margin-left: ${this.margin&&r.UiHelperUtil.getSpacingStyles(this.margin,3)};\n    `,i.html`<slot></slot>`}};d.styles=[n.resetStyles,s.default],l([(0,p.property)()],d.prototype,"gridTemplateRows",void 0),l([(0,p.property)()],d.prototype,"gridTemplateColumns",void 0),l([(0,p.property)()],d.prototype,"justifyItems",void 0),l([(0,p.property)()],d.prototype,"alignItems",void 0),l([(0,p.property)()],d.prototype,"justifyContent",void 0),l([(0,p.property)()],d.prototype,"alignContent",void 0),l([(0,p.property)()],d.prototype,"columnGap",void 0),l([(0,p.property)()],d.prototype,"rowGap",void 0),l([(0,p.property)()],d.prototype,"gap",void 0),l([(0,p.property)()],d.prototype,"padding",void 0),l([(0,p.property)()],d.prototype,"margin",void 0),e.WuiGrid=d=l([(0,o.customElement)('wui-grid')],d)},6074,[2,4553,4574,4552,4561,4563,6075]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var t=r(d[0]);e.default=t.css`
  :host {
    display: grid;
    width: inherit;
    height: inherit;
  }
`},6075,[4553]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.W3mAllWalletsListItem=void 0;var i=_r(_d[1]),s=_r(_d[2]),r=_r(_d[3]),l=_r(_d[4]),o=_r(_d[5]);_r(_d[6]),_r(_d[7]),_r(_d[8]),_r(_d[9]),_r(_d[10]);var n=t(_r(_d[11])),d=this&&this.__decorate||function(t,i,s,r){var l,o=arguments.length,n=o<3?i:null===r?r=Object.getOwnPropertyDescriptor(i,s):r;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)n=Reflect.decorate(t,i,s,r);else for(var d=t.length-1;d>=0;d--)(l=t[d])&&(n=(o<3?l(n):o>3?l(i,s,n):l(i,s))||n);return o>3&&n&&Object.defineProperty(i,s,n),n};let h=e.W3mAllWalletsListItem=class extends i.LitElement{constructor(){super(),this.observer=new IntersectionObserver(()=>{}),this.visible=!1,this.imageSrc=void 0,this.imageLoading=!1,this.isImpressed=!1,this.explorerId='',this.walletQuery='',this.certified=!1,this.displayIndex=0,this.wallet=void 0,this.observer=new IntersectionObserver(t=>{t.forEach(t=>{t.isIntersecting?(this.visible=!0,this.fetchImageSrc(),this.sendImpressionEvent()):this.visible=!1})},{threshold:.01})}firstUpdated(){this.observer.observe(this)}disconnectedCallback(){this.observer.disconnect()}render(){const t='certified'===this.wallet?.badge_type;return i.html`
      <button>
        ${this.imageTemplate()}
        <wui-flex flexDirection="row" alignItems="center" justifyContent="center" gap="1">
          <wui-text
            variant="md-regular"
            color="inherit"
            class=${(0,r.ifDefined)(t?'certified':void 0)}
            >${this.wallet?.name}</wui-text
          >
          ${t?i.html`<wui-icon size="sm" name="walletConnectBrown"></wui-icon>`:null}
        </wui-flex>
      </button>
    `}imageTemplate(){return!this.visible&&!this.imageSrc||this.imageLoading?this.shimmerTemplate():i.html`
      <wui-wallet-image
        size="lg"
        imageSrc=${(0,r.ifDefined)(this.imageSrc)}
        name=${(0,r.ifDefined)(this.wallet?.name)}
        .installed=${this.wallet?.installed??!1}
        badgeSize="sm"
      >
      </wui-wallet-image>
    `}shimmerTemplate(){return i.html`<wui-shimmer width="56px" height="56px"></wui-shimmer>`}async fetchImageSrc(){this.wallet&&(this.imageSrc=l.AssetUtil.getWalletImage(this.wallet),this.imageSrc||(this.imageLoading=!0,this.imageSrc=await l.AssetUtil.fetchWalletImage(this.wallet.image_id),this.imageLoading=!1))}sendImpressionEvent(){this.wallet&&!this.isImpressed&&(this.isImpressed=!0,l.EventsController.sendWalletImpressionEvent({name:this.wallet.name,walletRank:this.wallet.order,explorerId:this.explorerId,view:l.RouterController.state.view,query:this.walletQuery,certified:this.certified,displayIndex:this.displayIndex}))}};h.styles=n.default,d([(0,s.state)()],h.prototype,"visible",void 0),d([(0,s.state)()],h.prototype,"imageSrc",void 0),d([(0,s.state)()],h.prototype,"imageLoading",void 0),d([(0,s.state)()],h.prototype,"isImpressed",void 0),d([(0,s.property)()],h.prototype,"explorerId",void 0),d([(0,s.property)()],h.prototype,"walletQuery",void 0),d([(0,s.property)()],h.prototype,"certified",void 0),d([(0,s.property)()],h.prototype,"displayIndex",void 0),d([(0,s.property)({type:Object})],h.prototype,"wallet",void 0),e.W3mAllWalletsListItem=h=d([(0,o.customElement)('w3m-all-wallets-list-item')],h)},6076,[2,4553,4574,4588,4532,4550,4585,4643,4649,4647,4648,6077]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var o=r(d[0]);e.default=o.css`
  button {
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    cursor: pointer;
    width: 104px;
    row-gap: ${({spacing:o})=>o[2]};
    padding: ${({spacing:o})=>o[3]} ${({spacing:o})=>o[0]};
    background-color: ${({tokens:o})=>o.theme.foregroundPrimary};
    border-radius: clamp(0px, ${({borderRadius:o})=>o[4]}, 20px);
    transition:
      color ${({durations:o})=>o.lg} ${({easings:o})=>o['ease-out-power-1']},
      background-color ${({durations:o})=>o.lg}
        ${({easings:o})=>o['ease-out-power-1']},
      border-radius ${({durations:o})=>o.lg}
        ${({easings:o})=>o['ease-out-power-1']};
    will-change: background-color, color, border-radius;
    outline: none;
    border: none;
  }

  button > wui-flex > wui-text {
    color: ${({tokens:o})=>o.theme.textPrimary};
    max-width: 86px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    justify-content: center;
  }

  button > wui-flex > wui-text.certified {
    max-width: 66px;
  }

  @media (hover: hover) and (pointer: fine) {
    button:hover:enabled {
      background-color: ${({tokens:o})=>o.theme.foregroundSecondary};
    }
  }

  button:disabled > wui-flex > wui-text {
    color: ${({tokens:o})=>o.core.glass010};
  }

  [data-selected='true'] {
    background-color: ${({colors:o})=>o.accent020};
  }

  @media (hover: hover) and (pointer: fine) {
    [data-selected='true']:hover:enabled {
      background-color: ${({colors:o})=>o.accent010};
    }
  }

  [data-selected='true']:active:enabled {
    background-color: ${({colors:o})=>o.accent010};
  }

  @media (max-width: 350px) {
    button {
      width: 100%;
    }
  }
`},6077,[4550]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var t=r(d[0]);e.default=t.css`
  wui-grid {
    max-height: clamp(360px, 400px, 80vh);
    overflow: scroll;
    scrollbar-width: none;
    grid-auto-rows: min-content;
    grid-template-columns: repeat(auto-fill, 104px);
  }

  :host([data-mobile-fullscreen='true']) wui-grid {
    max-height: none;
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

  w3m-all-wallets-list-item {
    opacity: 0;
    animation-duration: ${({durations:t})=>t.xl};
    animation-timing-function: ${({easings:t})=>t['ease-inout-power-2']};
    animation-name: fade-in;
    animation-fill-mode: forwards;
  }

  @keyframes fade-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  wui-loading-spinner {
    padding-top: ${({spacing:t})=>t[4]};
    padding-bottom: ${({spacing:t})=>t[4]};
    justify-content: center;
    grid-column: 1 / span 4;
  }
`},6078,[4550]);
__d(function(g,_r,_i,a,m,e,_d){var t=_r(_d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.W3mAllWalletsSearch=void 0;var l=_r(_d[1]),i=_r(_d[2]),r=_r(_d[3]),o=_r(_d[4]);_r(_d[5]),_r(_d[6]),_r(_d[7]),_r(_d[8]),_r(_d[9]),_r(_d[10]);var n=t(_r(_d[11])),s=this&&this.__decorate||function(t,l,i,r){var o,n=arguments.length,s=n<3?l:null===r?r=Object.getOwnPropertyDescriptor(l,i):r;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)s=Reflect.decorate(t,l,i,r);else for(var c=t.length-1;c>=0;c--)(o=t[c])&&(s=(n<3?o(s):n>3?o(l,i,s):o(l,i))||s);return n>3&&s&&Object.defineProperty(l,i,s),s};let c=e.W3mAllWalletsSearch=class extends l.LitElement{constructor(){super(...arguments),this.prevQuery='',this.prevBadge=void 0,this.loading=!0,this.mobileFullScreen=r.OptionsController.state.enableMobileFullScreen,this.query=''}render(){return this.mobileFullScreen&&this.setAttribute('data-mobile-fullscreen','true'),this.onSearch(),this.loading?l.html`<wui-loading-spinner color="accent-primary"></wui-loading-spinner>`:this.walletsTemplate()}async onSearch(){this.query.trim()===this.prevQuery.trim()&&this.badge===this.prevBadge||(this.prevQuery=this.query,this.prevBadge=this.badge,this.loading=!0,await r.ApiController.searchWallet({search:this.query,badge:this.badge}),this.loading=!1)}walletsTemplate(){const{search:t}=r.ApiController.state,i=r.WalletUtil.markWalletsAsInstalled(t),o=r.WalletUtil.filterWalletsByWcSupport(i);return o.length?l.html`
      <wui-grid
        data-testid="wallet-list"
        .padding=${['0','3','3','3']}
        rowGap="4"
        columngap="2"
        justifyContent="space-between"
      >
        ${o.map((t,i)=>l.html`
            <w3m-all-wallets-list-item
              @click=${()=>this.onConnectWallet(t)}
              .wallet=${t}
              data-testid="wallet-search-item-${t.id}"
              explorerId=${t.id}
              certified=${'certified'===this.badge}
              walletQuery=${this.query}
              displayIndex=${i}
            ></w3m-all-wallets-list-item>
          `)}
      </wui-grid>
    `:l.html`
        <wui-flex
          data-testid="no-wallet-found"
          justifyContent="center"
          alignItems="center"
          gap="3"
          flexDirection="column"
        >
          <wui-icon-box size="lg" color="default" icon="wallet"></wui-icon-box>
          <wui-text data-testid="no-wallet-found-text" color="secondary" variant="md-medium">
            No Wallet found
          </wui-text>
        </wui-flex>
      `}onConnectWallet(t){r.ConnectorController.selectWalletConnector(t)}};c.styles=n.default,s([(0,i.state)()],c.prototype,"loading",void 0),s([(0,i.state)()],c.prototype,"mobileFullScreen",void 0),s([(0,i.property)()],c.prototype,"query",void 0),s([(0,i.property)()],c.prototype,"badge",void 0),e.W3mAllWalletsSearch=c=s([(0,o.customElement)('w3m-all-wallets-search')],c)},6079,[2,4553,4574,4532,4550,4585,6073,6005,4657,4647,6076,6080]);
__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var t=r(d[0]);e.default=t.css`
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

  :host([data-mobile-fullscreen='true']) wui-grid {
    max-height: none;
    height: auto;
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
`},6080,[4553]);
__d(function(g,_r,_i,a,m,e,_d){Object.defineProperty(e,"__esModule",{value:!0}),e.W3mDownloadsView=void 0;var t=_r(_d[0]),i=_r(_d[1]),r=_r(_d[2]);_r(_d[3]),_r(_d[4]),_r(_d[5]);var o=this&&this.__decorate||function(t,i,r,o){var l,n=arguments.length,s=n<3?i:null===o?o=Object.getOwnPropertyDescriptor(i,r):o;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)s=Reflect.decorate(t,i,r,o);else for(var h=t.length-1;h>=0;h--)(l=t[h])&&(s=(n<3?l(s):n>3?l(i,r,s):l(i,r))||s);return n>3&&s&&Object.defineProperty(i,r,s),s};let l=e.W3mDownloadsView=class extends t.LitElement{constructor(){super(...arguments),this.wallet=i.RouterController.state.data?.wallet}render(){if(!this.wallet)throw new Error('w3m-downloads-view');return t.html`
      <wui-flex gap="2" flexDirection="column" .padding=${['3','3','4','3']}>
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
      <wui-text variant="md-medium" color="primary">Chrome Extension</wui-text>
    </wui-list-item>`:null}iosTemplate(){return this.wallet?.app_store?t.html`<wui-list-item
      variant="icon"
      icon="appStore"
      iconVariant="square"
      @click=${this.onAppStore.bind(this)}
      chevron
    >
      <wui-text variant="md-medium" color="primary">iOS App</wui-text>
    </wui-list-item>`:null}androidTemplate(){return this.wallet?.play_store?t.html`<wui-list-item
      variant="icon"
      icon="playStore"
      iconVariant="square"
      @click=${this.onPlayStore.bind(this)}
      chevron
    >
      <wui-text variant="md-medium" color="primary">Android App</wui-text>
    </wui-list-item>`:null}homepageTemplate(){return this.wallet?.homepage?t.html`
      <wui-list-item
        variant="icon"
        icon="browser"
        iconVariant="square-blue"
        @click=${this.onHomePage.bind(this)}
        chevron
      >
        <wui-text variant="md-medium" color="primary">Website</wui-text>
      </wui-list-item>
    `:null}openStore(t){t.href&&this.wallet&&(i.EventsController.sendEvent({type:'track',event:'GET_WALLET',properties:{name:this.wallet.name,walletRank:this.wallet.order,explorerId:this.wallet.id,type:t.type}}),i.CoreHelperUtil.openHref(t.href,'_blank'))}onChromeStore(){this.wallet?.chrome_store&&this.openStore({href:this.wallet.chrome_store,type:'chrome_store'})}onAppStore(){this.wallet?.app_store&&this.openStore({href:this.wallet.app_store,type:'app_store'})}onPlayStore(){this.wallet?.play_store&&this.openStore({href:this.wallet.play_store,type:'play_store'})}onHomePage(){this.wallet?.homepage&&this.openStore({href:this.wallet.homepage,type:'homepage'})}};e.W3mDownloadsView=l=o([(0,r.customElement)('w3m-downloads-view')],l)},6081,[4553,4532,4550,4585,4658,4647]);