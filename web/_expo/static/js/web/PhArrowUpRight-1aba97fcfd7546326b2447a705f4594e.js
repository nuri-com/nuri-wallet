__d(function(g,_r,_i,_a,_m,e,d){Object.defineProperty(e,"__esModule",{value:!0}),e.PhArrowUpRight=void 0,_r(d[0]);var t=_r(d[1]),r=_r(d[2]),o=_r(d[3]),i=_r(d[4]),p=_r(d[5]),s=Object.defineProperty,a=Object.getOwnPropertyDescriptor,h=(t,r,o,i)=>{for(var p,h=i>1?void 0:i?a(r,o):r,l=t.length-1;l>=0;l--)(p=t[l])&&(h=(i?p(r,o,h):p(h))||h);return i&&h&&s(r,o,h),h};let l=class extends r.LitElement{constructor(){super(...arguments),this.size="1em",this.weight="regular",this.color="currentColor",this.mirrored=!1}render(){var r;return t.html`<svg
      xmlns="http://www.w3.org/2000/svg"
      width="${this.size}"
      height="${this.size}"
      fill="${this.color}"
      viewBox="0 0 256 256"
      transform=${this.mirrored?"scale(-1, 1)":null}
    >
      ${l.weightsMap.get(null!=(r=this.weight)?r:"regular")}
    </svg>`}};e.PhArrowUpRight=l,l.weightsMap=new Map([["thin",t.svg`<path d="M196,64V168a4,4,0,0,1-8,0V73.66L66.83,194.83a4,4,0,0,1-5.66-5.66L182.34,68H88a4,4,0,0,1,0-8H192A4,4,0,0,1,196,64Z"/>`],["light",t.svg`<path d="M198,64V168a6,6,0,0,1-12,0V78.48L68.24,196.24a6,6,0,0,1-8.48-8.48L177.52,70H88a6,6,0,0,1,0-12H192A6,6,0,0,1,198,64Z"/>`],["regular",t.svg`<path d="M200,64V168a8,8,0,0,1-16,0V83.31L69.66,197.66a8,8,0,0,1-11.32-11.32L172.69,72H88a8,8,0,0,1,0-16H192A8,8,0,0,1,200,64Z"/>`],["bold",t.svg`<path d="M204,64V168a12,12,0,0,1-24,0V93L72.49,200.49a12,12,0,0,1-17-17L163,76H88a12,12,0,0,1,0-24H192A12,12,0,0,1,204,64Z"/>`],["fill",t.svg`<path d="M200,64V168a8,8,0,0,1-13.66,5.66L140,127.31,69.66,197.66a8,8,0,0,1-11.32-11.32L128.69,116,82.34,69.66A8,8,0,0,1,88,56H192A8,8,0,0,1,200,64Z"/>`],["duotone",t.svg`<path d="M192,64V168L88,64Z" opacity="0.2"/><path d="M192,56H88a8,8,0,0,0-5.66,13.66L128.69,116,58.34,186.34a8,8,0,0,0,11.32,11.32L140,127.31l46.34,46.35A8,8,0,0,0,200,168V64A8,8,0,0,0,192,56Zm-8,92.69-38.34-38.34h0L107.31,72H184Z"/>`]]),l.styles=p.css`
    :host {
      display: contents;
    }
  `,h([(0,i.property)({type:String,reflect:!0})],l.prototype,"size",2),h([(0,i.property)({type:String,reflect:!0})],l.prototype,"weight",2),h([(0,i.property)({type:String,reflect:!0})],l.prototype,"color",2),h([(0,i.property)({type:Boolean,reflect:!0})],l.prototype,"mirrored",2),e.PhArrowUpRight=l=h([(0,o.customElement)("ph-arrow-up-right")],l)},4863,[4688,4690,4691,4692,4693,4689]);