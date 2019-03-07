import React, {Component} from 'react'
import './index.scss'
//添加事件监听
class ImgLazyLoad extends Component{
  constructor(props) {
    super(props)
    this.state = {
      isLoad: false,
      isLoading: false,
      // initUrl: 'https://ss0.bdstatic.com/-0U0bnSm1A5BphGlnYG/tam-ogel/8bc5c8ca3da4043fc6c9dbfb32d5dc89_121_121.jpg',
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
  initUrl: 'https://timgsa.baidu.com/timg?image&quality=80&size=b9999_10000&sec=1551957971666&di=a6595664d21ca2d40c47ac3ea7c038cd&imgtype=0&src=http%3A%2F%2Fb-ssl.duitang.com%2Fuploads%2Fitem%2F201808%2F01%2F20180801230125_PJTTh.thumb.224_0.gif'
}
export default ImgLazyLoad
