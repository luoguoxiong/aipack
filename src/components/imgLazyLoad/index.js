import React, {Component} from 'react'
import './index.scss'
//添加事件监听
class ImgLazyLoad extends Component{
  constructor(props) {
    super(props)
    this.state = {
      isLoad: false,
      isLoading: false,
    }
    this.handler = this.handler.bind(this);
  }
  componentDidMount () {
    this.handler()
    window.addEventListener('scroll', this.handler)
  }
  handler () {
    if(!this.state.isLoading){
      const {offSetTop, realUrl} = this.props
      const visibleBottom = window.scrollY + document.documentElement.clientHeight -offSetTop;
      const imgTop = this.refs.imgLazyLoad.offsetTop
      if(imgTop < visibleBottom){
        let imgObj = new Image()
        imgObj.src = realUrl
        this.setState({isLoading: true})
        new Promise((resolve, reject)=>{
          imgObj.onload = function(){
            resolve(imgObj)
          }
        }).then((imgObj)=>{
          this.setState({isLoad: true})
        })
      }
    }else{
      window.removeEventListener('scroll', this.handler)
    }
  }
  componentWillUnmount () {
    window.removeEventListener('scroll', this.handler)
  }
  render () {
    const { isLoad } = this.state
    const {realUrl, initUrl} = this.props
    const imgSrc = isLoad?realUrl: initUrl
    return (
      <img ref="imgLazyLoad" className={isLoad?'imgLazyload loadEnd': 'imgLazyload loading'} src={imgSrc} alt="imgLazyLoad"/>
    )
  }
}
ImgLazyLoad.defaultProps = {
  offSetTop: 40,
  initUrl: 'https://ss0.bdstatic.com/-0U0bnSm1A5BphGlnYG/tam-ogel/8bc5c8ca3da4043fc6c9dbfb32d5dc89_121_121.jpg'
}
export default ImgLazyLoad
