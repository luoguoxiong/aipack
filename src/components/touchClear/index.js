import React, {Component} from 'react'
import './index.scss'
import Header from "../header";
class TouchClear extends Component{
  state={
    startX: 0
  }
  clickRemove () {
    this.props.clickRemove()
  }
  tochStartDom (e){
    const _touch = e.touches[0]
    this.setState({
      startX: _touch.pageX
    })
  }
  tochMoveDom (e){
    const _touch = e.touches[0]
    if(this.state.startX>_touch.pageX+20 && this.props.isClose){
      this.props.toOpen()
    }
    if(this.state.startX<_touch.pageX-20 && !this.props.isClose){
      this.props.toClose()
    }
  }
  render () {
    const {collect} = this.props
    const classNames = this.props.isClose?'test':'test left'
    return (
      <div className="touchClear">
        <div className={classNames} onTouchStart={this.tochStartDom.bind(this)}
             onTouchMove={this.tochMoveDom.bind(this)}>
          {this.props.children}
        </div>
        <div className="colse" onClick={this.clickRemove.bind(this)}>
          {this.props.closeName}
        </div>
      </div>
    )
  }
}
TouchClear.defaultProps = {
  toClose: () => null,
  toOpen: () => null,
  closeName: '删除',
  isClose: true
}
export default TouchClear
