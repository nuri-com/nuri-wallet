__d(function(g,_r,_i,_a,m,e,_d){Object.defineProperty(e,"__esModule",{value:!0}),e.PhCaretRight=void 0,_r(_d[0]);var t=_r(_d[1]),r=_r(_d[2]),l=_r(_d[3]),o=_r(_d[4]),i=_r(_d[5]),s=Object.defineProperty,p=Object.getOwnPropertyDescriptor,h=(t,r,l,o)=>{for(var i,h=o>1?void 0:o?p(r,l):r,a=t.length-1;a>=0;a--)(i=t[a])&&(h=(o?i(r,l,h):i(h))||h);return o&&h&&s(r,l,h),h};let a=class extends r.LitElement{constructor(){super(...arguments),this.size="1em",this.weight="regular",this.color="currentColor",this.mirrored=!1}render(){var r;return t.html`<svg
      xmlns="http://www.w3.org/2000/svg"
      width="${this.size}"
      height="${this.size}"
      fill="${this.color}"
      viewBox="0 0 256 256"
      transform=${this.mirrored?"scale(-1, 1)":null}
    >
      ${a.weightsMap.get(null!=(r=this.weight)?r:"regular")}
    </svg>`}};e.PhCaretRight=a,a.weightsMap=new Map([["thin",t.svg`<path d="M178.83,130.83l-80,80a4,4,0,0,1-5.66-5.66L170.34,128,93.17,50.83a4,4,0,0,1,5.66-5.66l80,80A4,4,0,0,1,178.83,130.83Z"/>`],["light",t.svg`<path d="M180.24,132.24l-80,80a6,6,0,0,1-8.48-8.48L167.51,128,91.76,52.24a6,6,0,0,1,8.48-8.48l80,80A6,6,0,0,1,180.24,132.24Z"/>`],["regular",t.svg`<path d="M181.66,133.66l-80,80a8,8,0,0,1-11.32-11.32L164.69,128,90.34,53.66a8,8,0,0,1,11.32-11.32l80,80A8,8,0,0,1,181.66,133.66Z"/>`],["bold",t.svg`<path d="M184.49,136.49l-80,80a12,12,0,0,1-17-17L159,128,87.51,56.49a12,12,0,1,1,17-17l80,80A12,12,0,0,1,184.49,136.49Z"/>`],["fill",t.svg`<path d="M181.66,133.66l-80,80A8,8,0,0,1,88,208V48a8,8,0,0,1,13.66-5.66l80,80A8,8,0,0,1,181.66,133.66Z"/>`],["duotone",t.svg`<path d="M176,128,96,208V48Z" opacity="0.2"/><path d="M181.66,122.34l-80-80A8,8,0,0,0,88,48V208a8,8,0,0,0,13.66,5.66l80-80A8,8,0,0,0,181.66,122.34ZM104,188.69V67.31L164.69,128Z"/>`]]),a.styles=i.css`
    :host {
      display: contents;
    }
  `,h([(0,o.property)({type:String,reflect:!0})],a.prototype,"size",2),h([(0,o.property)({type:String,reflect:!0})],a.prototype,"weight",2),h([(0,o.property)({type:String,reflect:!0})],a.prototype,"color",2),h([(0,o.property)({type:Boolean,reflect:!0})],a.prototype,"mirrored",2),e.PhCaretRight=a=h([(0,l.customElement)("ph-caret-right")],a)},4932,[4751,4753,4754,4755,4756,4752]);