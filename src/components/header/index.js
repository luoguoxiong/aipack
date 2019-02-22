import React, { Component } from 'react'
import './index.css'
class Header extends Component{
  clickLeft () {
    this.props.clickLeft()
  }
  render () {
    return (
      <div className="header">
        <div className="left" onClick={this.clickLeft.bind(this)}>
          {this.props.left}
        </div>
        <div className="title">
          {this.props.title}
        </div>
        <div className="right">
          {this.props.right}
        </div>
      </div>
    )
  }
}

Header.defaultProps = {
  clickLeft: () => null,
  left: <i className="iconfont icon-i-left"></i>,
  right: null,
  title: '标题'
}
export default Header