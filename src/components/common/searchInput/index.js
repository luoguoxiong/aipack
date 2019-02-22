import React, {Component} from 'react'
import './index.scss'
class SearchInput extends Component{
  inputChange (e) {
    this.props.change(e.currentTarget.value)
  }
  submitInput(e){
    const {submit} = this.props
    const val = e.currentTarget.value.replace(/(^\s*)|(\s*$)/g, "")
    if(e.nativeEvent.keyCode === 13 && val !== ''){
      submit(val)
      this.refs.inputRef.blur()
    }
  }
  cancelInput(){
    this.refs.inputRef.blur()
    this.props.cancel()
  }
  chooseItem(item){
    this.props.chooseItem(item)
  }
  inputFocus(e){
    this.props.focus(e.currentTarget.value)
  }
  goBack () {
    this.props.goBack()
  }
  render () {
    const {searchList, value, placeholder} = this.props
    return (
      <div className="Input">
        <div className="searchInputWrap">
          <div className="goBack" onClick={this.goBack.bind(this)}>
            <i className="iconfont icon-i-left"></i>
          </div>
          <div className="icon">
            <i className="iconfont icon-search"></i>
          </div>
          <input ref="inputRef" type="text" value={value}
                 onFocus={this.inputFocus.bind(this)}
                 placeholder={placeholder}
                 onChange={this.inputChange.bind(this)} className="searchInput"
                 onKeyDown={this.submitInput.bind(this)} />
          <div className="cancelSearch" onClick={this.cancelInput.bind(this)}>取消</div>
        </div>
        {
          searchList.length>0?(
            <ul className="searchList">
              {
                searchList.map((item,index) => (
                  <li className="searchItem" key={index} onClick={this.chooseItem.bind(this,item)}>{item}</li>
                ))
              }
            </ul>
          ): null
        }
      </div>
    )
  }
}
export default SearchInput