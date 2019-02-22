import React, {Component} from 'react'
import './index.scss'
//添加事件监听
class ImgLazyLoad extends Component{
  state = {
    isLoad: false,
    isLoading: false,
    initUrl: 'https://ss0.bdstatic.com/-0U0bnSm1A5BphGlnYG/tam-ogel/8bc5c8ca3da4043fc6c9dbfb32d5dc89_121_121.jpg'
  }
  componentDidMount () {
    this.handler()
    this.regScroll(this.handler.bind(this));
  }
  loadingImg (imgSrc) {
    return new Promise((res,rej) => {
      let imgObj = new Image()
      imgObj.src = imgSrc
      imgObj.onload = function(){
        res(true)
      }
    })
  }
  handler () {
    const {offSetTop, realUrl} = this.props
    const visibleBottom = window.scrollY + document.documentElement.clientHeight -offSetTop;
    const imgTop = this.refs.imgLazyLoad.offsetTop
    if(imgTop < visibleBottom && !this.state.isLoading){
      this.setState({isLoading: true})
      new Promise((resolve, reject)=>{
        let imgObj = new Image()
        imgObj.src = realUrl
        imgObj.onload = function(){
          resolve(imgObj)
        }
      }).then((imgObj)=>{
        this.setState({isLoad: true})
      })
    }
  }
  componentWillUnmount () {
    window.onscroll = null
  }
  regScroll(myHandler) {
    if (window.onscroll === null) {
      window.onscroll = myHandler
    } else if (typeof window.onscroll === 'function') {
      var oldHandler = window.onscroll;
      window.onscroll = function () {
        myHandler();
        oldHandler();
      }
    }
  }
  render () {
    const { isLoad, initUrl } = this.state
    const {realUrl} = this.props
    const imgSrc = isLoad?realUrl: initUrl
    return (
      <img ref="imgLazyLoad" className={isLoad?'imgLazyload loadEnd': 'imgLazyload loading'} src={imgSrc} alt="imgLazyLoad"/>
    )
  }
}
export default ImgLazyLoad
